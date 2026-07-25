import { useState, useCallback } from "react";
import { N8N_BASE_URL } from "@/lib/constants";
import { useAuth } from "./useAuth";

export interface Agent {
  slug: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  color: string;
  endpoint: string;
  premium: boolean;
}

export const AGENTS: Agent[] = [
  {
    slug: "compta",
    name: "Agent Compta",
    category: "Finance",
    description: "Comptable expert 20 ans. Factures, TVA, declarations, bilans.",
    icon: "calculator",
    color: "#0EA5E9",
    endpoint: `${N8N_BASE_URL}/compta`,
    premium: false,
  },
  {
    slug: "email",
    name: "Agent Email",
    category: "Communication",
    description: "Redige, repond et gere tes emails professionnels.",
    icon: "mail",
    color: "#F59E0B",
    endpoint: `${N8N_BASE_URL}/email`,
    premium: false,
  },
  {
    slug: "juridique",
    name: "Agent Juridique",
    category: "Legal",
    description: "Avocat 30 ans d'experience. Contrats, litiges, conformite.",
    icon: "scale",
    color: "#6D28D9",
    endpoint: `${N8N_BASE_URL}/juridique`,
    premium: true,
  },
  {
    slug: "partenariat",
    name: "Agent Partenariat",
    category: "Business",
    description: "Trouve et gere tes partenaires commerciaux.",
    icon: "handshake",
    color: "#10B981",
    endpoint: `${N8N_BASE_URL}/partenariat`,
    premium: true,
  },
  {
    slug: "createur",
    name: "Agent Createur",
    category: "Contenu",
    description: "Cree du contenu marketing, posts, articles, videos.",
    icon: "pen-tool",
    color: "#E879F9",
    endpoint: `${N8N_BASE_URL}/createur`,
    premium: false,
  },
  {
    slug: "social",
    name: "Agent Social",
    category: "Reseaux sociaux",
    description: "Gere tes reseaux sociaux en pilote automatique.",
    icon: "share-2",
    color: "#3B82F6",
    endpoint: `${N8N_BASE_URL}/social`,
    premium: true,
  },
];

export function useAgentChat(agent: Agent) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || loading) return;

    const userMsg = { role: "user", content };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const response = await fetch(agent.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: content,
          user_id: user?.id,
          user_email: user?.email,
          history: messages.slice(-10),
        }),
      });

      if (!response.ok) throw new Error("Erreur serveur");

      const data = await response.json();
      const assistantContent = data?.output || data?.response || data?.message || "Je n'ai pas pu traiter ta demande. Reessaie.";

      setMessages(prev => [...prev, { role: "assistant", content: assistantContent }]);
    } catch {
      setMessages(prev => [
        ...prev,
        { role: "assistant", content: "Une erreur est survenue. Verifie ta connexion et reessaie." },
      ]);
    } finally {
      setLoading(false);
    }
  }, [agent, user, messages, loading]);

  const clearMessages = () => setMessages([]);

  return { messages, loading, sendMessage, clearMessages };
}
