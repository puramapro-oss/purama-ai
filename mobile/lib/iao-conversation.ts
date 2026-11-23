import type { SmaranaConversationSnapshot, SmaranaMessage } from "../../shared/smarana";
import type { SmaranaStore, SmaranaLocalRecord as LocalRecord, SmaranaConversationSummary, SmaranaHistoryCursor } from "./smarana-store";
import type { IaoLocalEngine, IaoLocalMessage } from "./iao-local-engine";

export type ConversationView = {
  record: LocalRecord | null;
  conversations: SmaranaConversationSummary[];
  hasMoreHistory: boolean;
  draft: string;
  dirty: boolean;
  busy: boolean;
  transitioning: boolean;
  liveText: string;
  error: string | null;
  contextTruncated: boolean;
};
const instruction = "Tu es PURAMA, l’assistant personnel de cette personne. Réponds dans la langue de sa demande. "
  + "Tu travailles sur cet appareil. Tu peux expliquer, raisonner et rédiger du texte. "
  + "Tu ne disposes pas d’Internet ni d’outils pour envoyer, acheter ou publier. "
  + "N’affirme jamais avoir fait une action que tu n’as pas effectuée. Signale tes incertitudes. "
  + "Le contexte contient seulement une partie bornée des échanges conservés. /no_think";

// Match the native adapter's input limits before calling it. The durable
// transcript is never truncated; only this inference window is bounded.
function contextWindow(messages: readonly SmaranaMessage[]): { messages: IaoLocalMessage[]; truncated: boolean } {
  const eligible = messages.filter(message => message.content.trim() && (message.state === "complete" || message.state === "interrupted"));
  const selected: IaoLocalMessage[] = [];
  let characters = instruction.length;
  for (let index = eligible.length - 1; index >= 0; index--) {
    const message = eligible[index];
    if (selected.length >= 127 || message.content.length > 32_000 || characters + message.content.length > 256_000) break;
    selected.unshift({ role: message.role, content: message.content });
    characters += message.content.length;
  }
  while (selected[0]?.role === "assistant") selected.shift();
  return { messages: [{ role: "system", content: instruction }, ...selected], truncated: selected.length < eligible.length };
}

/** The UI, native completion and replica all operate on the same durable transcript. */
export function createIaoConversation(dependencies: {
  store: SmaranaStore;
  engine: Pick<IaoLocalEngine, "complete" | "cancel">;
  uuid: () => string;
  now?: () => string;
}) {
  const { store, engine, uuid } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const emptyView = (): ConversationView => ({ record: null, conversations: [], hasMoreHistory: false, draft: "", dirty: false,
    busy: false, transitioning: false, liveText: "", error: null, contextTruncated: false });
  let state: ConversationView = emptyView();
  let closed = false;
  let closingRequested = false;
  let closingTask: Promise<void> | null = null;
  let transitionTask: Promise<unknown> | null = null;
  let draftRevision = 0;
  let savedDraftRevision = 0;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let draftTask: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let activeGeneration: AbortController | null = null;
  let generationTask: Promise<void> | null = null;
  let terminalRecovery: { resourceId: string; assistantId: string; content: string } | null = null;
  let historyPages = 1;
  let historyCursor: SmaranaHistoryCursor | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<ConversationView>) => {
    if (closed) return;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const assertOpen = () => { if (closed) throw new Error("La conversation est fermée."); };
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = writes.then(async () => { assertOpen(); return work(); });
    writes = result.catch(() => {});
    return result;
  };
  const report = (error: unknown) => {
    if (!closed) publish({ error: error instanceof Error ? error.message : "L’opération n’a pas abouti." });
  };
  const fresh = async (): Promise<LocalRecord> => {
    if (state.record && !state.record.tombstone) return state.record;
    const record = await store.create({ title: "Nouvelle conversation", messages: [], draft: state.draft });
    assertOpen();
    publish({ record });
    return record;
  };
  const commit = async (record: LocalRecord, payload: SmaranaConversationSnapshot, draftOnly = false) => {
    if (record.tombstone || (record.syncState === "conflict" && (!draftOnly
      || payload.title !== record.payload?.title || JSON.stringify(payload.messages) !== JSON.stringify(record.payload?.messages)))) {
      throw new Error("Résolvez le conflit avant de modifier cette conversation.");
    }
    let result: LocalRecord;
    try { result = await store.update(record.resourceId, record.localVersion, payload); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "local_conflict") {
        const latest = await store.read(record.resourceId);
        assertOpen();
        publish({ record: latest }); // Retain the still-dirty keyboard draft.
      }
      throw error;
    }
    assertOpen();
    publish({ record: result });
    return result;
  };
  const saveInterrupted = async () => {
    if (!terminalRecovery) return;
    await serial(async () => {
      const recovery = terminalRecovery;
      if (!recovery) return;
      const record = state.record;
      if (!record?.payload || record.resourceId !== recovery.resourceId
        || !record.payload.messages.some(message => message.id === recovery.assistantId)) {
        throw new Error("La réponse partielle doit être conservée avant de fermer cette conversation.");
      }
      await commit(record, { ...record.payload, messages: record.payload.messages.map(message =>
        message.id === recovery.assistantId ? { ...message, content: recovery.content || message.content, state: "interrupted" } : message) });
      if (terminalRecovery === recovery) terminalRecovery = null;
      publish({ liveText: "" });
    });
  };
  const list = async () => {
    const conversations: SmaranaConversationSummary[] = [];
    const seen = new Set<string>();
    let cursor: SmaranaHistoryCursor | null = null;
    for (let index = 0; index < historyPages; index++) {
      const page = await store.listPage({ cursor, limit: 50 });
      assertOpen();
      for (const record of page.records) if (!seen.has(record.resourceId)) { seen.add(record.resourceId); conversations.push(record); }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assertOpen();
    historyCursor = cursor;
    publish({ conversations, hasMoreHistory: cursor !== null });
    return conversations;
  };
  const flush = (): Promise<void> => {
    clearTimeout(draftTimer);
    if (draftTask) return draftTask;
    if (draftRevision === savedDraftRevision) return Promise.resolve();
    const task = serial(async () => {
      while (savedDraftRevision !== draftRevision) {
        const revision = draftRevision;
        const draft = state.draft;
        const record = await fresh();
        if (!record.payload) throw new Error("Cette conversation a été supprimée.");
        await commit(record, { ...record.payload, draft }, true);
        savedDraftRevision = revision;
        publish({ dirty: draftRevision !== savedDraftRevision, error: null });
      }
      await list();
    });
    draftTask = task;
    void task.finally(() => { if (draftTask === task) draftTask = null; }).catch(() => {});
    return task;
  };
  const setDraft = (draft: string) => {
    assertOpen();
    if (state.busy || state.transitioning || closingRequested || draft === state.draft) return;
    draftRevision++;
    publish({ draft, dirty: true });
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { void flush().catch(report); }, 300);
  };
  const transition = <T>(work: () => Promise<T>): Promise<T> => {
    assertOpen();
    if (state.busy || state.transitioning || closingRequested) throw new Error("Attendez la fin de l’opération avant de changer de conversation.");
    publish({ transitioning: true });
    const task = (async () => {
      try { await saveInterrupted(); return await work(); }
      finally { publish({ transitioning: closingRequested }); }
    })();
    transitionTask = task;
    void task.finally(() => { if (transitionTask === task) transitionTask = null; }).catch(() => {});
    return task;
  };
  const open = (resourceId?: string) => transition(async () => {
    await flush();
    await serial(async () => {
      const conversations = await list();
      const selectedId = resourceId ?? conversations[0]?.resourceId;
      const record = selectedId ? await store.read(selectedId) : null;
      assertOpen();
      if (resourceId && (!record || record.tombstone)) throw new Error("Cette conversation n’est plus disponible.");
      draftRevision = savedDraftRevision = 0;
      publish({ record, conversations, draft: record?.payload?.draft ?? "", dirty: false, liveText: "", error: null });
    });
  });
  const refresh = async () => {
    if (closed || state.busy || state.transitioning || closingRequested) return;
    await serial(async () => {
      const currentId = state.record?.resourceId;
      const record = currentId ? await store.read(currentId) : null;
      const conversations = await list();
      assertOpen();
      // A pull cannot clear a newer, still uncommitted keyboard edit.
      publish({ record, conversations, ...(state.dirty ? {} : { draft: record?.payload?.draft ?? "" }) });
    });
  };
  const send = async () => {
    assertOpen();
    if (state.busy || state.transitioning || closingRequested || !state.draft.trim()) return;
    if (state.draft.trim().length > 32_000) {
      publish({ error: "Cette demande est trop longue pour le moteur local. Votre brouillon est conservé ; envoyez-le en plusieurs parties." });
      return;
    }
    publish({ busy: true, error: null, ...(terminalRecovery ? {} : { liveText: "" }), contextTruncated: false });
    const controller = new AbortController();
    activeGeneration = controller;
    let assistantId: string | null = null;
    let partial = "";
    let terminal = false;
    const checkpoint = () => serial(async () => {
      if (terminal || !assistantId || closed) return;
      const record = state.record;
      if (!record?.payload) return;
      await commit(record, { ...record.payload, messages: record.payload.messages.map(message =>
        message.id === assistantId ? { ...message, content: partial, state: "pending" } : message) });
    });
    const task = (async () => {
      try {
        await saveInterrupted();
        await flush();
        if (controller.signal.aborted) throw new Error("Réponse arrêtée.");
        const content = state.draft.trim();
        await serial(async () => {
          const record = await fresh();
          if (!record.payload) throw new Error("Cette conversation a été supprimée.");
          if (record.payload.messages.length > 510) throw new Error("Cette conversation est pleine. Ouvrez une nouvelle conversation ; celle-ci reste conservée.");
          const nextAssistantId = uuid();
          const user: SmaranaMessage = { id: uuid(), role: "user", content, state: "complete", createdAt: now() };
          const assistant: SmaranaMessage = { id: nextAssistantId, role: "assistant", content: "", state: "pending", createdAt: now() };
          await commit(record, { title: record.payload.messages.length ? record.payload.title : [...content].slice(0, 80).join(""),
            messages: [...record.payload.messages, user, assistant], draft: "" });
          assistantId = nextAssistantId;
          draftRevision++;
          savedDraftRevision = draftRevision;
          publish({ draft: "", dirty: false });
        });
        if (controller.signal.aborted) throw new Error("Réponse arrêtée.");
        const window = contextWindow(state.record!.payload!.messages);
        const result = await engine.complete(window.messages, {
          signal: controller.signal,
          onToken: text => {
            if (closed || terminal || controller.signal.aborted) return;
            partial = text;
            publish({ liveText: text });
            if (!checkpointTimer) checkpointTimer = setTimeout(() => {
              checkpointTimer = undefined;
              void checkpoint().catch(error => { report(error); controller.abort(); });
            }, 800);
          },
        });
        if (controller.signal.aborted) throw new Error("Réponse arrêtée.");
        partial = result.text;
        terminal = true;
        terminalRecovery = { resourceId: state.record!.resourceId, assistantId: assistantId!, content: partial };
        publish({ liveText: partial });
        clearTimeout(checkpointTimer); checkpointTimer = undefined;
        await serial(async () => {
          const record = state.record;
          if (!record?.payload || !assistantId) throw new Error("Conversation indisponible.");
          await commit(record, { ...record.payload, messages: record.payload.messages.map(message =>
            message.id === assistantId ? { ...message, content: result.text, state: result.finishReason === "length" ? "interrupted" : "complete" } : message) });
          terminalRecovery = null;
          publish({ liveText: "", contextTruncated: window.truncated || result.contextTruncated,
            error: result.finishReason === "length" ? "La réponse a atteint sa limite. Vous pouvez demander à PURAMA de poursuivre." : null });
        });
      } catch (error) {
        terminal = true;
        clearTimeout(checkpointTimer); checkpointTimer = undefined;
        if (!closed && assistantId) {
          terminalRecovery = { resourceId: state.record!.resourceId, assistantId, content: partial };
          publish({ liveText: partial });
          try {
            await saveInterrupted();
          } catch (saveError) { report(saveError); return; }
        }
        report(error);
      } finally {
        clearTimeout(checkpointTimer); checkpointTimer = undefined;
        if (activeGeneration === controller) activeGeneration = null;
        publish({ busy: false });
        if (!closed) await list().catch(report);
      }
    })();
    generationTask = task;
    try { await task; } finally { if (generationTask === task) generationTask = null; }
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open, refresh, setDraft, flush, send,
    loadMoreHistory() { return transition(async () => {
      await flush();
      await serial(async () => {
        if (!historyCursor) return;
        const page = await store.listPage({ cursor: historyCursor, limit: 50 });
        assertOpen();
        const seen = new Set(state.conversations.map(record => record.resourceId));
        const conversations = [...state.conversations, ...page.records.filter(record => !seen.has(record.resourceId))];
        historyPages += 1;
        historyCursor = page.nextCursor;
        publish({ conversations, hasMoreHistory: historyCursor !== null });
      });
    }); },
    stop() { activeGeneration?.abort(); },
    newConversation() { return transition(async () => {
      await flush();
      assertOpen();
      draftRevision = savedDraftRevision = 0;
      publish({ record: null, draft: "", dirty: false, liveText: "", error: null, contextTruncated: false });
    }); },
    removeConversation() { return transition(async () => {
      await flush();
      await serial(async () => {
        const record = state.record;
        if (record) await store.tombstone(record.resourceId, record.localVersion);
        publish({ record: null, draft: "", dirty: false, liveText: "", error: null });
        draftRevision = savedDraftRevision = 0;
        await list();
      });
    }); },
    resolveConflict(choice: "remote" | "keep-both") { return transition(async () => {
      await flush();
      await serial(async () => {
        if (!state.record) return;
        const result = await store.resolveConflict(state.record.resourceId, state.record.localVersion, choice);
        const record = result.preserved ?? (result.record.tombstone ? null : result.record);
        publish({ record, draft: record?.payload?.draft ?? "", error: null });
        await list();
      });
    }); },
    close(): Promise<void> {
      if (closingTask) return closingTask;
      if (closed) return Promise.resolve();
      closingRequested = true;
      publish({ transitioning: true });
      activeGeneration?.abort();
      const task = (async () => {
        try {
          await transitionTask;
          await generationTask;
          if (closed) return;
          await saveInterrupted();
          await flush();
          await writes;
          assertOpen();
          publish(emptyView());
          closed = true;
          clearTimeout(draftTimer); clearTimeout(checkpointTimer);
          listeners.clear();
        } catch (error) {
          if (closed) return;
          closingRequested = false;
          publish({ transitioning: false });
          report(error);
          throw error; // Navigation must keep this recoverable view open.
        }
      })();
      closingTask = task;
      void task.finally(() => { if (closingTask === task) closingTask = null; }).catch(() => {});
      return task;
    },
    invalidate() {
      closed = true;
      activeGeneration?.abort();
      clearTimeout(draftTimer); clearTimeout(checkpointTimer);
      state = emptyView();
      listeners.clear();
    },
  };
}
export type IaoConversation = ReturnType<typeof createIaoConversation>;
