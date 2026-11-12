import { getRobotTarget, type RobotTarget } from "./catalog.js";
import { RobotSessionError } from "./session.js";

export interface RobotConnectionGuide {
  target: RobotTarget;
  status: "simulation_available" | "connector_required";
  hardwareConnected: false;
  method: string;
  phone: string;
  steps: string[];
  capabilities: Array<{ name: string; availability: "preview" | "unavailable" }>;
}

// These are connection instructions, never a discovery response or an authorization.
const instructions: Record<string, { method: string; phone: string; steps: string[] }> = {
  "tesla-optimus": {
    method: "Accès constructeur à obtenir",
    phone: "Une application Tesla ne suffit pas à donner à PURAMA le contrôle d'Optimus.",
    steps: ["Obtenir une interface Optimus autorisée par Tesla.", "Développer le connecteur correspondant aux commandes disponibles.", "Valider chaque commande sur le modèle et le firmware concernés."],
  },
  "unitree-g1-edu": {
    method: "Logiciel local utilisant le SDK Unitree",
    phone: "Le téléphone pourrait piloter PURAMA via un logiciel relié au robot ; l'accès dépend de l'édition G1.",
    steps: ["Vérifier l'édition EDU et ses droits de développement.", "Configurer le SDK officiel et la liaison réseau sur un ordinateur ou le calculateur autorisé.", "Raccorder PURAMA puis qualifier la voix, les mains et les mouvements séparément."],
  },
  "unitree-g1-unistore": {
    method: "Application installée par UniStore",
    phone: "Le parcours passe par l'application autorisée et les permissions accordées par Unitree.",
    steps: ["Confirmer l'éligibilité du modèle, du firmware et du compte à UniStore.", "Préparer l'application PURAMA et ses permissions nécessaires.", "Valider le transfert de contrôle et le retour au contrôleur constructeur."],
  },
  "1x-neo": {
    method: "Application constructeur ; accès tiers à confirmer",
    phone: "L'application et l'audio Bluetooth annoncés ne prouvent pas l'accès de PURAMA aux moteurs ou aux microphones.",
    steps: ["Confirmer les fonctions tierces accessibles avec 1X.", "Obtenir une interface autorisée pour les fonctions retenues.", "Développer et tester le connecteur PURAMA."],
  },
  "fourier-gr2": {
    method: "Logiciel local utilisant Aurora SDK",
    phone: "Une interface PURAMA sur téléphone nécessite un logiciel local compatible avec le SDK.",
    steps: ["Vérifier le modèle GR-2 et les versions de firmware requises par Aurora.", "Installer et configurer le SDK sur un calculateur autorisé.", "Développer le connecteur et valider les commandes sur ce robot."],
  },
  "pollen-reachy2": {
    method: "SDK Reachy 2 sur le même réseau local",
    phone: "Le Wi-Fi est documenté. Le SDK Python demande une adresse IP ; un logiciel local est nécessaire pour le relier à PURAMA sur téléphone.",
    steps: ["Placer le robot et l'ordinateur sur le même réseau, en Wi-Fi ou Ethernet.", "Relever l'adresse IP et vérifier la connexion avec le SDK Reachy 2.", "Raccorder PURAMA puis tester séparément audio, bras, tête et base mobile."],
  },
};

export function getRobotConnectionGuide(targetId: string): RobotConnectionGuide {
  const target = getRobotTarget(targetId);
  if (!target) throw new RobotSessionError("UNKNOWN_TARGET", "Modèle de robot inconnu.");
  const simulation = target.stage === "simulator";
  const setup = simulation ? {
    method: "Aperçu dans ce navigateur",
    phone: "Disponible sur ce navigateur, sans installation supplémentaire. L'aperçu n'émet aucun son et ne commande aucun robot.",
    steps: ["Préparer le texte et les durées.", "Lancer l'aperçu de la séance.", "Mettre en pause, reprendre ou arrêter à tout moment."],
  } : Object.prototype.hasOwnProperty.call(instructions, targetId) ? instructions[targetId] : {
    method: "Intégration avec le constructeur à qualifier",
    phone: "Le contrôle depuis un téléphone dépend d'une interface constructeur et d'un connecteur PURAMA validé.",
    steps: ["Confirmer le modèle, le firmware et les droits du propriétaire.", "Obtenir la documentation et les accès autorisés du constructeur.", "Développer le connecteur puis qualifier les fonctions réellement disponibles."],
  };
  return {
    target,
    status: simulation ? "simulation_available" : "connector_required",
    hardwareConnected: false,
    ...structuredClone(setup),
    capabilities: ["Parole", "Gestes nommés", "Pauses", "Déplacements", "Caméra", "Microphone"].map((name, index) => ({
      name, availability: simulation && index < 3 ? "preview" : "unavailable",
    })),
  };
}
