/** Research targets are deliberately separate from installed, validated connectors. */
export interface RobotTarget {
  id: string;
  manufacturer: string;
  model: string;
  stage: "target" | "documented_interface" | "simulator";
  hardwareControlAvailable: false;
  hardwareValidation: "not_tested" | "not_applicable";
  interfaceNote: string;
  sources: string[];
  reviewedOn: string;
}

const targets: RobotTarget[] = [
  {
    id: "tesla-optimus", manufacturer: "Tesla", model: "Optimus", stage: "target",
    interfaceNote: "Cible prioritaire. Aucune interface Optimus exploitable identifiée dans les sources consultées ; Fleet API concerne véhicules et énergie.",
    sources: ["https://developer.tesla.com/", "https://www.tesla.com/AI"],
  },
  {
    id: "unitree-g1-edu", manufacturer: "Unitree", model: "G1 EDU", stage: "documented_interface",
    interfaceNote: "SDK officiel et exemples G1. Édition, firmware, mains, droits audio et mouvement à qualifier avant tout raccordement.",
    sources: ["https://shop.unitree.com/products/unitree-g1", "https://github.com/unitreerobotics/unitree_sdk2_python"],
  },
  {
    id: "unitree-g1-unistore", manufacturer: "Unitree", model: "G1 / UniStore", stage: "documented_interface",
    interfaceNote: "Template UniStore officiel avec permissions et transfert de contrôle explicites. Accès développeur, édition G1, firmware, pays et approbation à confirmer ; ne prouve pas que le G1 standard est déverrouillé.",
    sources: ["https://unistore.unitree.com/", "https://github.com/unitreerobotics/unitree-app-templates", "https://github.com/unitreerobotics/unitree-app-templates/blob/main/g1_mimic_demo/README.md"],
  },
  {
    id: "1x-neo", manufacturer: "1X", model: "NEO", stage: "documented_interface",
    interfaceNote: "Application et enceinte Bluetooth annoncées ; audio sortant ne prouve ni accès micro ni commande motrice. Plateforme développeur à qualifier.",
    sources: ["https://www.1x.tech/neo", "https://www.1x.tech/discord"],
  },
  {
    id: "figure-03", manufacturer: "Figure", model: "Figure 03", stage: "target",
    interfaceNote: "Autonomie Helix documentée ; aucun connecteur IAO ni droit d'installation tiers validé ici.",
    sources: ["https://www.figure.ai/news/helix-02"],
  },
  {
    id: "boston-atlas", manufacturer: "Boston Dynamics", model: "Atlas", stage: "target",
    interfaceNote: "Plateforme industrielle avec intégration Orbit annoncée. Ne pas confondre les interfaces d'Atlas avec le SDK Spot ; accès client et commandes disponibles à qualifier.",
    sources: ["https://bostondynamics.com/products/atlas/"],
  },
  {
    id: "apptronik-apollo", manufacturer: "Apptronik", model: "Apollo / Apollo 2", stage: "target",
    interfaceNote: "Cible d'intégration ; édition, interfaces, droits et configuration de mobilité à confirmer avec le fabricant.",
    sources: ["https://apptronik.com/", "https://apptronik.com/apollo/apollo-2"],
  },
  {
    id: "ubtech-walker", manufacturer: "UBTECH", model: "Walker", stage: "target",
    interfaceNote: "Famille cible. Une interface domotique ne prouve pas l'accès aux articulations du robot.",
    sources: ["https://www.ubtrobot.com/en/humanoid/products/walker"],
  },
  {
    id: "fourier-gr2", manufacturer: "Fourier", model: "GR-2", stage: "documented_interface",
    interfaceNote: "SDK Aurora publié pour GR-2 entre autres modèles ; les prérequis firmware et la qualification matérielle restent nécessaires.",
    sources: ["https://github.com/FFTAI/fourier_aurora_sdk"],
  },
  {
    id: "agility-digit", manufacturer: "Agility Robotics", model: "Digit", stage: "documented_interface",
    interfaceNote: "Agility Arc annonce l'intégration aux systèmes industriels ; documentation d'API, accès client et portée exacte à obtenir avant implémentation.",
    sources: ["https://www.agilityrobotics.com/solutions"],
  },
  {
    id: "pollen-reachy2", manufacturer: "Pollen Robotics", model: "Reachy 2", stage: "documented_interface",
    interfaceNote: "SDK mouvement, perception et audio. Référence de banc d'essai à base roulante, distincte de la cible bipède.",
    sources: ["https://docs.pollen-robotics.com/developing-with-reachy-2/sdk-introduction/discover-sdk/"],
  },
].map((target) => ({
  ...target,
  stage: target.stage as RobotTarget["stage"],
  hardwareControlAvailable: false,
  hardwareValidation: "not_tested",
  reviewedOn: "2026-10-30",
}));

targets.push({
  id: "purama-simulator", manufacturer: "PURAMA", model: "Simulateur de séances",
  stage: "simulator", hardwareControlAvailable: false, hardwareValidation: "not_applicable",
  interfaceNote: "Simulation logicielle uniquement : aucun son émis, aucun mouvement, aucune connexion à un robot.",
  sources: [], reviewedOn: "2026-10-30",
});

/** Return copies: a caller cannot mutate research targets into enabled hardware. */
export function listRobotTargets(): RobotTarget[] {
  return structuredClone(targets);
}

export function getRobotTarget(id: string): RobotTarget | undefined {
  const target = targets.find((item) => item.id === id);
  return target ? structuredClone(target) : undefined;
}
