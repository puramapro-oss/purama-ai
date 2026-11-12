import { useEffect, useRef, useState } from 'react';
import { AppState, Button, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Link, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authorizeWatch, clearWatchAuthorization, discoverWatches,
  subscribeWatchStatus, WATCH_KINDS, type WatchDevice, type WatchKind, type WatchNativeStatus } from '../modules/purama-accessibility-watch';

const labels: Record<WatchKind, string> = { doorbell: 'Sonnette', speech: 'Voix possible', siren: 'Sirène', 'vehicle-sound': 'Bruit de véhicule', horn: 'Klaxon',
  knock: 'Coups', 'telephone-ring': 'Sonnerie de téléphone', vehicle: 'Véhicule dans une image', 'sensor-unavailable': 'Observation indisponible' };
const availableKinds = WATCH_KINDS.filter(kind => kind !== 'vehicle' && kind !== 'sensor-unavailable');
const statusText: Record<WatchNativeStatus['state'], string> = {
  idle: 'Aucune session autorisée.', discovering: 'Recherche des montres proches…', 'awaiting-watch': 'Comparez le code et autorisez la session sur la montre.',
  connected: 'Session confirmée par la montre. La livraison d’une observation reste à vérifier.', disconnected: 'Session fermée. Utilisez le téléphone.',
  revoked: 'Autorisation retirée. Utilisez le téléphone.', unavailable: 'Le module natif est absent de cette version.', error: 'Connexion indisponible. Vous pouvez réessayer.',
};
export default function AccessibilityWatchScreen() {
  const [devices, setDevices] = useState<readonly WatchDevice[]>([]);
  const [device, setDevice] = useState('');
  const [kinds, setKinds] = useState<WatchKind[]>([]);
  const [status, setStatus] = useState<WatchNativeStatus>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [failure, setFailure] = useState('');
  const handoff = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const remove = subscribeWatchStatus(s => { if (mounted.current) setStatus(s); });
    const app = AppState.addEventListener('change', state => { if (state !== 'active') { ++revision.current; handoff.current = false; void clearWatchAuthorization().catch(() => {}); } });
    return () => { mounted.current = false; ++revision.current; remove(); app.remove(); if (!handoff.current) void clearWatchAuthorization().catch(() => {}); };
  }, []);
  const discover = async () => {
    if (busy || closing) return;
    setBusy(true); setFailure(''); setStatus({ state: 'discovering' });
    try { const found = await discoverWatches(); if (mounted.current) { setDevices(found); setDevice(''); setStatus({ state: 'idle' }); if (!found.length) setFailure('Ouvrez PURAMA sur la montre appairée, puis relancez la recherche.'); } }
    catch { if (mounted.current) { setFailure('Aucune montre disponible dans cette version ou cet état du téléphone.'); setStatus({ state: 'error' }); } }
    finally { if (mounted.current) setBusy(false); }
  };
  const close = async () => {
    if (closing) return;
    ++revision.current; handoff.current = false;
    setClosing(true); setFailure('');
    try { await clearWatchAuthorization(); if (mounted.current) setStatus({ state: 'idle' }); }
    catch { if (mounted.current) setFailure('Arrêt non confirmé. Réessayez de retirer l’autorisation.'); }
    finally { if (mounted.current) { setClosing(false); setBusy(false); } }
  };
  const connect = async () => {
    if (busy || closing || !device || !kinds.length) return;
    const expected = ++revision.current;
    setBusy(true); setFailure('');
    try {
      await authorizeWatch({ deviceId: device, allowedKinds: kinds });
      if (!mounted.current || expected !== revision.current || AppState.currentState !== 'active') {
        await clearWatchAuthorization(); return;
      }
      // A one-use permission, valid for at most 60 seconds, follows this explicit
      // navigation. ONE still needs its own Connect action and watch-side consent.
      handoff.current = true;
      router.replace('/accessible-one');
    } catch {
      handoff.current = false;
      await clearWatchAuthorization().catch(() => {});
      if (mounted.current) setFailure('L’autorisation n’a pas été préparée. Vous pouvez réessayer.');
    } finally { if (mounted.current) setBusy(false); }
  };
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content}>
    <Text accessibilityRole="header" style={styles.title}>Connexion à ma montre</Text>
    <Text style={styles.text}>Cette connexion demande votre accord sur les deux appareils. Le téléphone et la montre doivent rester ouverts. Aucun événement de démonstration n’est envoyé.</Text>
    <Text style={styles.text} accessibilityLiveRegion="polite">{statusText[status.state]}</Text>
    {status.pairingCode ? <Text style={styles.code} accessibilityLabel={`Code : ${status.pairingCode.split('').join(' ')}`}>{status.pairingCode}</Text> : null}
    <Button title="Rechercher les montres proches" onPress={() => void discover()} disabled={busy || closing} />
    {devices.map(watch => <View key={watch.deviceId} style={styles.choice}><Text style={styles.text}>{watch.name}</Text><Button title={device === watch.deviceId ? 'Montre choisie' : 'Choisir cette montre'} disabled={busy || closing} onPress={() => setDevice(watch.deviceId)} /></View>)}
    <Text accessibilityRole="header" style={styles.heading}>Observations autorisées</Text>
    <Text style={styles.text}>Cette version raccorde les sept observations sonores ci-dessous. Les images et les notifications d’autres applications ne sont pas relayées.</Text>
    {availableKinds.map(kind => <View key={kind} style={styles.choice}><Text style={styles.label}>{labels[kind]}</Text><Switch accessibilityLabel={`Autoriser : ${labels[kind]}`} value={kinds.includes(kind)} disabled={busy || closing} onValueChange={yes => setKinds(old => yes ? [...old, kind] : old.filter(k => k !== kind))} /></View>)}
    <Text style={styles.text}>Seules la catégorie du son, son heure et les informations de session sont transmises à la montre. Aucun audio ni propos transcrit n’est envoyé. Sur Wear OS, le transport dépend des services Google et peut utiliser leur réseau ; une montre proche ne garantit pas un trajet Bluetooth uniquement.</Text>
    <Button title="Autoriser pour ONE et ouvrir" onPress={() => void connect()} disabled={!device || !kinds.length || busy || closing} />
    <Button title={closing ? 'Fermeture en cours…' : 'Retirer l’autorisation'} onPress={() => void close()} disabled={closing} />
    {failure ? <Text role="alert" style={styles.failure}>{failure}</Text> : null}
    <Text style={styles.text}>Une réception, un affichage et votre bouton « J’ai compris » sont trois étapes distinctes. Aucun reçu ne prouve qu’une vibration a été ressentie. Ces observations ne donnent aucune consigne de déplacement.</Text>
    <Text style={styles.text}>L’autorisation préparée expire au bout d’une minute. Dans ONE, choisissez ensuite « Connecter et partager les nouveaux sons », puis confirmez sur la montre. Sans cette confirmation, aucune observation n’est transmise.</Text>
    <Link href="/accessible-one" style={styles.link}>Ouvrir les outils ONE</Link>
    <Link href="/(tabs)/settings" style={styles.link}>Revenir aux paramètres</Link>
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#111827' }, content: { padding: 20, gap: 16 }, title: { color: '#ffffff', fontSize: 26, fontWeight: '700' }, heading: { color: '#ffffff', fontSize: 21, fontWeight: '600' },
  text: { color: '#f3f4f6', fontSize: 17, lineHeight: 25 }, label: { color: '#f3f4f6', fontSize: 17, flex: 1 }, choice: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  code: { color: '#ffffff', fontSize: 30, letterSpacing: 3 }, failure: { color: '#fecaca', fontSize: 17 }, link: { color: '#bfdbfe', fontSize: 18, paddingVertical: 12, textDecorationLine: 'underline' },
});
