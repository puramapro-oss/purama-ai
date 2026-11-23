import { useState } from "react";
import { View, Text, TextInput, FlatList, ScrollView, KeyboardAvoidingView, Platform,
  TouchableOpacity, Switch, Alert, ActivityIndicator, StyleSheet, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/components/ui/Button";
import { COLORS } from "@/lib/constants";
import { usePuramaConversation } from "@/hooks/usePuramaConversation";
import thirdPartyNotices from "@/assets/iao-third-party-notices.json";

const syncLabels = { idle: "Prêt à synchroniser", syncing: "Synchronisation en cours…", paused: "Synchronisation en pause",
  pending: "En attente de synchronisation", conflict: "Versions à rapprocher", synced: "Synchronisé avec votre compte" };

export default function PuramaConversationScreen() {
  const chat = usePuramaConversation();
  const [history, setHistory] = useState(false);
  const [details, setDetails] = useState(false);
  const [licenses, setLicenses] = useState(false);
  const { view } = chat;
  const navigation = useNavigation();
  usePreventRemove(view.dirty || view.busy || !!view.liveText, ({ data }) => {
    void chat.prepareToLeave().then(() => navigation.dispatch(data.action)).catch(() => {});
  });
  const messages = view.record?.payload?.messages ?? [];
  const conflict = view.record?.syncState === "conflict";
  const ready = chat.pack?.status === "ready";
  const problem = chat.error ?? view.error;
  const remove = () => Alert.alert("Supprimer cette conversation ?",
    "La suppression sera transmise à votre compte lorsque la synchronisation sera possible.",
    [{ text: "Conserver", style: "cancel" }, { text: "Supprimer", style: "destructive", onPress: () => { void chat.remove(); } }]);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retour" testID="purama-back" onPress={() => router.back()} style={styles.icon}>
          <Ionicons name="arrow-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={styles.title}>PURAMA</Text>
          <Text style={styles.caption}>Votre assistant personnel</Text>
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Mes conversations" testID="purama-history"
          disabled={view.busy || view.transitioning} onPress={() => setHistory(!history)} style={styles.icon}>
          <Ionicons name="time-outline" size={23} color={COLORS.text} />
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Nouvelle conversation" testID="purama-new"
          disabled={view.busy || view.transitioning || chat.phase !== "ready"} onPress={() => { setHistory(false); void chat.newConversation(); }} style={styles.icon}>
          <Ionicons name="add" size={26} color={COLORS.text} />
        </TouchableOpacity>
      </View>

      {chat.phase === "loading" && <View style={styles.notice}><ActivityIndicator color={COLORS.accentLight} /><Text style={styles.body}>Ouverture de votre mémoire…</Text></View>}
      {chat.phase === "unavailable" && <View style={styles.notice}><Text style={styles.body}>La conversation sur cet appareil demande l’application PURAMA installée avec ses composants natifs.</Text></View>}
      {(chat.phase === "account" || chat.phase === "error") && <ScrollView contentContainerStyle={styles.setup}>
        <Text style={styles.heading}>Votre PURAMA, même sans Internet</Text>
        <Text style={styles.body}>Associez cet appareil à votre compte, puis préparez ses ressources. Les conversations seront conservées sur cet appareil et pourront rejoindre le même compte après reconnexion.</Text>
        <Text style={styles.caption}>La première vérification utilise Internet. L’accès local est valable sept jours sur cet appareil déverrouillé ; une nouvelle vérification le renouvelle. Une déconnexion ferme l’accès à la mémoire.</Text>
        <Button testID="purama-verify-account" title="Vérifier mon compte pour cet appareil" loading={chat.preparing} onPress={() => { void chat.verifyAccount(); }} />
        <Button testID="purama-login" title="Connecter mon compte" variant="secondary" onPress={() => router.push("/account")} />
        {chat.phase === "error" && <Button title="Réessayer l’ouverture" variant="secondary" onPress={() => { void chat.retry(); }} />}
      </ScrollView>}

      {chat.phase === "ready" && <>
        <View style={styles.status}>
          <Text testID="purama-save-status" accessibilityLiveRegion="polite" style={styles.caption}>
            {view.dirty ? "Enregistrement de votre saisie…" : view.busy ? "Votre message est enregistré — réponse en cours de sauvegarde…"
              : view.liveText ? "Une partie de la réponse reste à enregistrer" : view.record ? "Enregistré sur cet appareil" : "Votre conversation sera enregistrée sur cet appareil"}
          </Text>
          <TouchableOpacity accessibilityRole="button" testID="purama-details" onPress={() => setDetails(!details)}>
            <Text style={styles.link}>{syncLabels[chat.syncState]}</Text>
          </TouchableOpacity>
        </View>
        {details && <View style={styles.settings}>
          <View style={styles.row}>
            <Text style={[styles.body, { flex: 1 }]}>Synchronisation automatique du compte</Text>
            <Switch testID="purama-auto-sync" accessibilityLabel="Synchronisation automatique du compte"
              value={chat.account?.autoSync ?? false} onValueChange={value => { void chat.setAutoSync(value); }}
              trackColor={{ true: COLORS.accent, false: COLORS.surface2 }} />
          </View>
          <Text style={styles.caption}>Les échanges sont produits sur cet appareil. La synchronisation transmet vos conversations à votre compte ; elle n’envoie aucun message à un tiers et ne lance aucune action externe.</Text>
          {chat.syncMessage && <Text style={styles.caption}>{chat.syncMessage}</Text>}
          <Button title="Synchroniser maintenant" variant="secondary" disabled={!chat.account?.autoSync || view.busy || view.dirty}
            onPress={() => { void chat.synchronize(); }} />
          <Button title="Renouveler l’accès de cet appareil" variant="ghost" loading={chat.preparing} onPress={() => { void chat.verifyAccount(); }} />
          <Text style={styles.caption}>Composants : llama.rn et llama.cpp (MIT), Qwen3-0.6B (Apache 2.0). Les licences accompagnent les ressources installées. Le pack compact peut se tromper ; vérifiez les informations décisives.</Text>
          <Button testID="purama-licenses" title="Licences des composants" variant="ghost" onPress={() => setLicenses(true)} />
        </View>}

        {history ? <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.setup}>
          <Text accessibilityRole="header" style={styles.heading}>Mes conversations</Text>
          {!view.conversations.length && <Text style={styles.caption}>Vos conversations apparaîtront ici dès leur premier enregistrement.</Text>}
          {view.conversations.map(record => <TouchableOpacity key={record.resourceId} accessibilityRole="button"
            testID={`purama-conversation-${record.resourceId}`} style={styles.historyItem}
            disabled={view.busy || view.transitioning}
            onPress={() => { setHistory(false); void chat.select(record.resourceId); }}>
            <Text style={styles.body} numberOfLines={2}>{record.title || "Conversation"}</Text>
            <Text style={styles.caption}>{record.syncState === "conflict" ? "Versions à rapprocher" : record.syncState === "synced" ? "Dans votre compte" : "Conservée sur cet appareil"}</Text>
          </TouchableOpacity>)}
          {view.hasMoreHistory && <Button testID="purama-more-history" title="Charger d’autres conversations" variant="secondary"
            disabled={view.busy || view.transitioning} onPress={() => { void chat.loadMoreHistory(); }} />}
        </ScrollView> : <>
          {!ready && <View style={styles.settings}>
            <Text style={styles.body}>{chat.preparing ? "Préparation de PURAMA sur cet appareil…" : "Préparez PURAMA pour qu’il puisse vous répondre sans Internet."}</Text>
            <Text style={styles.caption}>Un téléchargement d’environ 640 Mo est nécessaire une fois. Le fichier est vérifié puis le moteur est essayé localement avant de devenir disponible.</Text>
            {chat.preparing ? <>
              <Text testID="purama-pack-progress" style={styles.caption}>{Math.round((chat.pack?.progress ?? 0) * 100)} %</Text>
              <Button title="Arrêter la préparation" variant="secondary" onPress={chat.stop} />
            </> : <Button testID="purama-prepare" title="Préparer PURAMA sur cet appareil" onPress={() => { void chat.preparePack(); }} />}
            {chat.pack?.message && <Text style={styles.caption}>{chat.pack.message}</Text>}
          </View>}
          {conflict && <View style={styles.settings}>
            <Text style={styles.body}>Cette conversation a changé sur un autre appareil. Votre version locale est conservée.</Text>
            <Button testID="purama-keep-both" title="Conserver les deux versions" variant="secondary" onPress={() => { void chat.resolve("keep-both"); }} />
            <Button testID="purama-accept-remote" title="Reprendre la version du compte" variant="ghost" disabled={!!view.record?.tombstone}
              onPress={() => Alert.alert("Reprendre la version du compte ?", "La variante locale de cette conversation sera remplacée. Vous pouvez conserver les deux versions à la place.",
                [{ text: "Annuler", style: "cancel" }, { text: "Reprendre", onPress: () => { void chat.resolve("remote"); } }])} />
          </View>}
          <FlatList style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }} data={messages}
            keyExtractor={item => item.id} keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<View style={{ gap: 12, paddingVertical: 20 }}><Text style={styles.heading}>Qu’allez-vous créer ?</Text>
              <Text style={styles.body}>Expliquez une idée, préparez un texte ou poursuivez une réflexion. Votre conversation reste ici après fermeture de l’application.</Text></View>}
            renderItem={({ item }) => <View style={[styles.message, item.role === "user" ? styles.userMessage : styles.assistantMessage]}>
              <Text style={styles.author}>{item.role === "user" ? "Vous" : "PURAMA"}</Text>
              <Text selectable style={styles.body}>{item.state === "pending" && view.liveText ? view.liveText
                : item.content || (item.state === "pending" ? "Réponse en préparation…" : "La réponse s’est arrêtée avant la production de texte.")}</Text>
              {item.state === "interrupted" && <Text style={styles.caption}>Réponse interrompue — contenu partiel conservé.</Text>}
              {item.state === "pending" && <Text style={styles.caption}>{view.busy ? "Réponse en cours…" : "Réponse en cours sur un autre appareil."}</Text>}
            </View>} />
          {view.contextTruncated && <Text style={[styles.caption, { paddingHorizontal: 16 }]}>Une partie récente de la conversation a été utilisée pour cette réponse. L’historique complet reste enregistré.</Text>}
          {view.record && !view.busy && !view.transitioning && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Supprimer cette conversation"
            testID="purama-delete" onPress={remove} style={{ alignSelf: "flex-end", padding: 12 }}><Text style={styles.link}>Supprimer la conversation</Text></TouchableOpacity>}
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.composer}>
              <TextInput testID="purama-input" accessibilityLabel="Message pour PURAMA" style={styles.input}
                placeholder="Écrivez à PURAMA…" placeholderTextColor={COLORS.textSecondary}
                value={view.draft} onChangeText={chat.setDraft} multiline maxLength={16_000}
                editable={!view.busy && !view.transitioning && !conflict} selectionColor={COLORS.accentLight} />
              {view.busy ? <Button testID="purama-stop" title="Arrêter" onPress={chat.stop} variant="secondary" />
                : <Button testID="purama-send" title="Envoyer" disabled={!ready || view.transitioning || !view.draft.trim() || !!conflict}
                  onPress={() => { void chat.send(); }} />}
            </View>
          </KeyboardAvoidingView>
        </>}
      </>}
      {problem && <View style={styles.problem}><Text accessibilityRole="alert" style={styles.body}>{problem}</Text>
        {view.dirty && <Button title="Réessayer l’enregistrement" variant="secondary" onPress={() => { void chat.save(); }} />}</View>}
      {licenses ? <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setLicenses(false)}>
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]} accessibilityViewIsModal>
          <View style={[styles.header, { paddingHorizontal: 16 }]}>
            <Text accessibilityRole="header" style={[styles.heading, { flex: 1 }]}>Licences des composants</Text>
            <Button testID="purama-licenses-close" title="Fermer" variant="secondary" onPress={() => setLicenses(false)} />
          </View>
          <ScrollView testID="purama-license-texts" contentContainerStyle={styles.setup}>
            <Text style={styles.body}>{thirdPartyNotices.scope}</Text>
            {thirdPartyNotices.components.map(component => <View key={component.name} style={{ gap: 12 }}>
              <Text accessibilityRole="header" style={styles.heading}>{component.name}</Text>
              <Text style={styles.caption}>{component.version} · {component.license}</Text>
              {component.texts.map((notice, index) => <View key={`${component.name}-${index}`} style={{ gap: 8 }}>
                <Text style={styles.body}>{notice.title}</Text>
                <Text selectable style={styles.caption}>{notice.content}</Text>
              </View>)}
              {component.sources.map(source => <Text key={source} selectable style={styles.caption}>{source}</Text>)}
            </View>)}
          </ScrollView>
        </SafeAreaView>
      </Modal> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: "row", alignItems: "center", padding: 8, borderBottomWidth: 1, borderColor: COLORS.border },
  title: { color: COLORS.text, fontSize: 22, fontWeight: "700" },
  heading: { color: COLORS.text, fontSize: 22, lineHeight: 30, fontWeight: "700" },
  body: { color: COLORS.text, fontSize: 16, lineHeight: 24 },
  caption: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 20 },
  link: { color: COLORS.accentLight, fontSize: 13, lineHeight: 22 },
  icon: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  notice: { padding: 24, gap: 16, alignItems: "center" },
  setup: { padding: 24, gap: 18 },
  status: { paddingHorizontal: 16, paddingVertical: 10, gap: 3 },
  settings: { backgroundColor: COLORS.surface, padding: 16, gap: 12, borderBottomWidth: 1, borderColor: COLORS.border },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  historyItem: { padding: 16, gap: 6, backgroundColor: COLORS.surface, borderRadius: 14 },
  message: { padding: 14, borderRadius: 16, gap: 6, maxWidth: "94%" },
  userMessage: { alignSelf: "flex-end", backgroundColor: COLORS.accentDark },
  assistantMessage: { alignSelf: "flex-start", backgroundColor: COLORS.surface2 },
  author: { color: COLORS.text, fontSize: 12, lineHeight: 18, fontWeight: "700" },
  composer: { padding: 12, gap: 10, borderTopWidth: 1, borderColor: COLORS.border },
  input: { color: COLORS.text, backgroundColor: COLORS.surface2, borderRadius: 14, padding: 14,
    fontSize: 16, lineHeight: 24, minHeight: 54, maxHeight: 150, textAlignVertical: "top" },
  problem: { borderTopWidth: 1, borderColor: COLORS.warning, padding: 14, gap: 10 },
});
