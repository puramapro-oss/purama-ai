export const SUPER_ADMIN_EMAIL = "matiss.frasne@gmail.com";
export const WALLET_MIN_WITHDRAWAL = 5;
export const N8N_BASE_URL = "https://n8n.srv1286148.hstgr.cloud/webhook";
export const APP_SLUG = "purama_ai";

export const COMPANY_INFO = {
  name: "SASU PURAMA",
  address: "8 Rue de la Chapelle, 25560 Frasne",
  siret: "",
  tva: "Article 293B du CGI",
  asso: "Association PURAMA - 10% du CA reverse",
};

export const COLORS = {
  background: "#0A0A0F",
  surface: "#111118",
  surface2: "#1A1A24",
  accent: "#8B5CF6",
  accentLight: "#A78BFA",
  accentDark: "#6D28D9",
  success: "#10B981",
  warning: "#F59E0B",
  error: "#EF4444",
  text: "#FFFFFF",
  textSecondary: "#9CA3AF",
  border: "rgba(255,255,255,0.06)",
  glass: "rgba(255,255,255,0.05)",
};

export const PLANS = [
  { id: "free", name: "Gratuit", price: 0, agents: 2, messages: 10 },
  { id: "starter", name: "Starter", price: 9.99, agents: 5, messages: 100 },
  { id: "pro", name: "Pro", price: 24.99, agents: 15, messages: 500 },
  { id: "unlimited", name: "Unlimited", price: 49.99, agents: 45, messages: -1 },
  { id: "enterprise", name: "Enterprise", price: 99.99, agents: 45, messages: -1 },
];

export const REFERRAL_TIERS = [
  { name: "Bronze", min: 5, color: "#CD7F32" },
  { name: "Argent", min: 10, color: "#C0C0C0" },
  { name: "Or", min: 25, color: "#FFD700" },
  { name: "Platine", min: 50, color: "#E5E4E2" },
  { name: "Diamant", min: 75, color: "#B9F2FF" },
  { name: "Legende", min: 100, color: "#FF6B6B" },
];
