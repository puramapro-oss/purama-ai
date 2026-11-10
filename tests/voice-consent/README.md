# Voix : arrêt, confidentialité et contrats de conversation

Depuis la racine du dépôt, après installation des dépendances et de Chromium Playwright :

```sh
npx playwright test --config tests/voice-consent/playwright.config.ts
```

`PLAYWRIGHT_EXECUTABLE_PATH` peut sélectionner un Chromium local. Le serveur de test écoute uniquement sur `127.0.0.1:4194`. Les sorties réseau externes sont bloquées. Le dossier de résultats est propre à cette suite : `test-results/voice-consent`.

Les 17 scénarios exécutent les vrais composants `VoiceMode` et `AgentChatTab`, le vrai hook `useVoice`, les trois helpers de conversation et le schéma UUID du serveur. Les services de parole et les périphériques sont simulés ; deux scénarios utilisent également les vraies fonctions de transport vocal pour vérifier l'annulation pendant l'encodage audio et la lecture du jeton.

La couverture comprend :

- UUID valides et distincts pour les trois chats, y compris sans `crypto.randomUUID` ;
- aucune nouvelle requête après un signal déjà annulé ou une attente devenue périmée ;
- permission microphone obtenue après annulation : fermeture des pistes ;
- abandon pendant arrêt du recorder ou transcription : aucune relance de conversation ;
- succès/échec TTS tardif, résultats dans le désordre, fermeture et changement de compte ;
- interruption avec lecture automatique activée, libération des URL audio et absence de reprise tardive ;
- capture et conversation normales, puis retour à l'état de repos après la lecture.

Les transports simulés peuvent renvoyer volontairement un succès malgré l'annulation. Les contrôles locaux doivent alors empêcher toute nouvelle réponse ou lecture.

Ces tests ne valident pas un microphone matériel, une API de parole réelle, la qualité d'un modèle ni les navigateurs autres que celui effectivement lancé. Un arrêt ne peut pas retirer rétroactivement une requête déjà reçue par un prestataire. La propagation du signal annule les appels encore contrôlés par le client et les résultats périmés sont ignorés.
