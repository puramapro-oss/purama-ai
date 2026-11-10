// These reviewed UI strings cover French and English. Other app languages use
// explicit English content (lang="en") until their wellbeing copy is reviewed.
const COPY = {
  fr: {
    common: { close: 'Fermer', stop: 'Arrêter', finish: 'Terminer', optional: 'Facultatif', helpful: 'Utile', neutral: 'Neutre', uncomfortable: 'Inconfortable', feedback: 'Comment cette pause t’a-t-elle convenu ? Réponse facultative.', thanks: 'Merci. Tu peux poursuivre ta journée à ton rythme.', discomfort: 'Tu peux arrêter et choisir une autre activité. Tu n’as rien à réussir ici.' },
    pause: {
      trigger: 'Pause facultative', title: 'Un moment à ton rythme', description: 'Choisis ce qui te convient. Rien ne démarre sans ton choix, et tu peux fermer à tout moment.',
      neutral: 'Une pause simple', kindness: 'Un geste de bienveillance', spiritual: 'Un moment spirituel, si tu le souhaites',
      neutralText: 'Prends un instant pour remarquer tes appuis ou un objet autour de toi. Respire naturellement. Tu peux ensuite choisir un petit pas réaliste pour ta journée.',
      kindnessText: 'Pense à un geste simple et possible : te parler avec respect, poser une limite, ou remercier quelqu’un. Tu n’as pas à te forcer à ressentir quelque chose.',
      spiritualText: 'Si cela correspond à tes convictions, tu peux consacrer ce moment à la paix, à une prière ou à une intention personnelle. Tu choisis les mots et leur sens ; aucune croyance ni résultat n’est attendu.',
      done: 'J’ai terminé cette pause', change: 'Choisir une autre pause', note: 'Aucune note spirituelle, aucun point ni série. Ton choix et ton ressenti restent dans cette séance.'
    },
    breath: {
      title: 'Pause respiration', description: 'Une pause libre, sans rétention ni rythme imposé.', instructions: 'Respire naturellement et sans forcer. Tu peux garder les yeux ouverts, remarquer tes appuis, ou simplement rester assis. Arrête si tu ressens un inconfort.',
      duration: 'Durée indicative', seconds: 'secondes', start: 'Commencer', pause: 'Pause', resume: 'Reprendre', restart: 'Recommencer', ready: 'À ton rythme', running: 'Respire librement', paused: 'En pause', stopped: 'Pause arrêtée', complete: 'Temps écoulé', remaining: 'Temps restant',
      result: 'Le minuteur est terminé. Cela ne mesure ni ta santé ni la qualité de ta pratique.', alternative: 'Si la respiration ne te convient pas, tu peux simplement regarder autour de toi ou reprendre une activité ordinaire.'
    },
    journal: {
      title: 'Journal de gratitude', description: 'Un moment que tu souhaites retenir, sans obligation quotidienne.', label: 'Qu’aimerais-tu noter ?', placeholder: 'Un moment, une personne ou un geste qui a compté…', add: 'Ajouter une note', cancel: 'Annuler', save: 'Enregistrer la note', empty: 'Aucune note pour cette séance.', invitation: 'Tu peux écrire quelques mots, ou laisser cet espace vide.',
      remember: 'Conserver mes notes sur cet appareil', device: 'Ce choix conserve les notes dans ce navigateur, pour ce compte. Elles ne sont pas envoyées à l’IA. Évite cette option sur un appareil partagé.', session: 'Par défaut, les notes restent seulement dans cette séance et disparaissent en quittant la page.',
      disabled: 'Connecte-toi pour choisir la conservation sur cet appareil.', remove: 'Supprimer cette note', today: 'Aujourd’hui', saved: 'Note enregistrée.', deleted: 'Note supprimée.', forgotten: 'Conservation désactivée : la copie enregistrée sur cet appareil a été supprimée. Les notes restent visibles dans cette séance.',
      storageError: 'Le navigateur a refusé l’opération. Aucune suppression ni conservation supplémentaire n’est confirmée.', invalid: 'Le journal enregistré n’a pas pu être chargé. Il n’a pas été effacé ni attribué à un autre compte.', limit: 'Ce journal peut contenir jusqu’à 500 notes. Supprime une note avant d’en ajouter une autre.', maxLength: '2 000 caractères maximum.',
      conflict: 'Une autre fenêtre a modifié ce journal. Aucune note n’a été écrasée ; tes notes de séance et ton brouillon restent ici.', revoked: 'La conservation a été désactivée dans une autre fenêtre. Ton brouillon reste ici ; aucune nouvelle note n’a été enregistrée sur l’appareil.', locksUnavailable: 'La conservation fiable entre fenêtres n’est pas disponible dans ce navigateur. Tu peux utiliser le journal de séance.', busy: 'Le journal est occupé dans une autre fenêtre. Aucune modification n’est confirmée ; ton brouillon reste ici. Tu peux réessayer.', working: 'Enregistrement en cours…'
    }
  },
  en: {
    common: { close: 'Close', stop: 'Stop', finish: 'Finish', optional: 'Optional', helpful: 'Helpful', neutral: 'Neutral', uncomfortable: 'Uncomfortable', feedback: 'How did this pause feel? Answering is optional.', thanks: 'Thank you. You can return to your day at your own pace.', discomfort: 'You can stop and choose another activity. There is nothing to achieve here.' },
    pause: {
      trigger: 'Optional pause', title: 'A moment at your own pace', description: 'Choose what suits you. Nothing starts without your choice, and you can close this at any time.',
      neutral: 'A simple pause', kindness: 'A kind gesture', spiritual: 'A spiritual moment, if you wish',
      neutralText: 'Take a moment to notice the support beneath you or an object around you. Breathe naturally. Then, if you wish, choose one small, realistic step for your day.',
      kindnessText: 'Consider a simple, possible gesture: speaking to yourself respectfully, setting a boundary, or thanking someone. You do not have to make yourself feel anything.',
      spiritualText: 'If it fits your beliefs, you may dedicate this moment to peace, a prayer, or a personal intention. You choose the words and what they mean; no belief or outcome is expected.',
      done: 'I have finished this pause', change: 'Choose another pause', note: 'No spiritual score, points, or streak. Your choice and feedback remain in this session.'
    },
    breath: {
      title: 'Breathing pause', description: 'An optional pause, without breath holding or a required pace.', instructions: 'Breathe naturally, without forcing. You may keep your eyes open, notice your surroundings, or simply sit. Stop if you feel uncomfortable.',
      duration: 'Suggested duration', seconds: 'seconds', start: 'Start', pause: 'Pause', resume: 'Resume', restart: 'Start again', ready: 'At your own pace', running: 'Breathe freely', paused: 'Paused', stopped: 'Pause stopped', complete: 'Time is up', remaining: 'Time remaining',
      result: 'The timer has finished. This does not measure your health or the quality of your practice.', alternative: 'If focusing on breathing does not suit you, you can simply look around or return to an everyday activity.'
    },
    journal: {
      title: 'Gratitude journal', description: 'A moment you want to remember, without a daily obligation.', label: 'What would you like to note?', placeholder: 'A moment, person, or gesture that mattered…', add: 'Add a note', cancel: 'Cancel', save: 'Save note', empty: 'No notes in this session.', invitation: 'You can write a few words or leave this space empty.',
      remember: 'Keep my notes on this device', device: 'This choice keeps notes in this browser for this account. They are not sent to the AI. Avoid this option on a shared device.', session: 'By default, notes stay only in this session and disappear when you leave this page.',
      disabled: 'Sign in to choose storage on this device.', remove: 'Delete this note', today: 'Today', saved: 'Note saved.', deleted: 'Note deleted.', forgotten: 'Device storage is off: the saved copy on this device has been deleted. Notes remain visible in this session.',
      storageError: 'The browser refused the operation. No additional storage or deletion has been confirmed.', invalid: 'The saved journal could not be loaded. It has not been erased or assigned to another account.', limit: 'This journal can hold up to 500 notes. Delete a note before adding another.', maxLength: 'Maximum 2,000 characters.',
      conflict: 'Another window changed this journal. No notes have been overwritten; your session notes and draft remain here.', revoked: 'Device storage was turned off in another window. Your draft remains here; no new note has been saved on this device.', locksUnavailable: 'Reliable storage across windows is unavailable in this browser. You can still use the session journal.', busy: 'The journal is busy in another window. No change has been confirmed; your draft remains here. You can retry.', working: 'Saving…'
    }
  }
} as const;

export function wellbeingCopy(language?: string) {
  const locale = language?.toLowerCase().split(/[-_]/)[0] === 'fr' ? 'fr' : 'en';
  return { locale, ...COPY[locale] };
}
