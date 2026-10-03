export const TEST_RESULT_LABEL = 'Mode test — résultat simulé';

export function runProvenanceLabel(usesMock: boolean): string | null {
  return usesMock ? TEST_RESULT_LABEL : null;
}

export function unavailableLiveDataLabel(source: string): string {
  return `Données indisponibles — connexion ${source} requise`;
}
