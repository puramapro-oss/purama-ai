import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { WebView } from 'react-native-webview';
import { clearWatchAuthorization, createNativeWatchChallenge, createNativeWatchHost, subscribeWatchStatus, type WatchNativeStatus } from '@/modules/purama-accessibility-watch';
import { buildOneNativeHostScript, createOneWebBridge, isOneAccessibilityUrl, parseOneOrigin } from '@/lib/accessibility-one-bridge';

const origin = parseOneOrigin(process.env.EXPO_PUBLIC_ONE_ACCESSIBILITY_ORIGIN);
type Bridge = ReturnType<typeof createOneWebBridge>;
// Keep unconfirmed closures across screen unmounts. A new opening retries them
// before it can install another bridge; a React remount never erases the fault.
const pendingClosures = new Set<Bridge>();
let authorizationCloseRequired = false;
async function closePendingAuthorization() {
  if (!authorizationCloseRequired) return;
  await clearWatchAuthorization();
  authorizationCloseRequired = false;
}
async function closePendingBridges() {
  const results = await Promise.allSettled([...pendingClosures].map(async bridge => {
    await bridge.close(); pendingClosures.delete(bridge);
  }));
  if (results.some(result => result.status === 'rejected')) throw new Error('Native close unconfirmed');
}

export default function AccessibleOneScreen() {
  const web = useRef<WebView>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const loadCount = useRef(0);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentBridge = useRef<Bridge | null>(null);
  const opening = useRef(false);
  const [session, setSession] = useState<{ key: number; script: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [watchStatus, setWatchStatus] = useState<WatchNativeStatus | null>(null);
  const [message, setMessage] = useState(origin
    ? 'Ouvrez vos outils ONE. La connexion à une montre et l’écoute des sons se déclenchent ensuite à votre demande.'
    : 'Le parcours ONE n’est pas encore relié à cette version mobile. Vous pouvez déjà communiquer par écrit sur ce téléphone.');

  const stop = useCallback(async (reason: string) => {
    const closingGeneration = ++generation.current;
    opening.current = false;
    if (deadline.current) clearTimeout(deadline.current);
    deadline.current = undefined;
    if (currentBridge.current) pendingClosures.add(currentBridge.current);
    currentBridge.current = null;
    authorizationCloseRequired = true;
    if (mounted.current) { setSession(null); setBusy(true); setWatchStatus(null); }
    try {
      const outcomes = await Promise.allSettled([closePendingBridges(), closePendingAuthorization()]);
      if (outcomes.some(result => result.status === 'rejected')) throw new Error('Native close unconfirmed');
      if (mounted.current && generation.current === closingGeneration) setMessage(reason);
      return true;
    } catch {
      if (mounted.current && generation.current === closingGeneration) setMessage('L’arrêt du lien montre n’a pas été confirmé. Réessayez « Arrêter et fermer » avant de rouvrir le parcours.');
      return false;
    } finally { if (mounted.current && generation.current === closingGeneration) setBusy(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void stop('Le parcours a été fermé en arrière-plan. Rouvrez-le quand vous le souhaitez.');
    });
    const unsubscribeStatus = subscribeWatchStatus(status => {
      if (mounted.current && currentBridge.current) setWatchStatus(status);
    });
    return () => {
      mounted.current = false; subscription.remove();
      try { unsubscribeStatus(); } catch { /* The next explicit stop still revokes the native authorization. */ }
      void stop('Parcours fermé.');
    };
  }, [stop]);
  useFocusEffect(useCallback(() => () => { void stop('Parcours fermé.'); }, [stop]));

  async function open() {
    if (!origin || opening.current || busy || session) return;
    opening.current = true; setBusy(true);
    const attempt = ++generation.current;
    try {
      await Promise.all([closePendingBridges(), closePendingAuthorization()]);
      if (!mounted.current || attempt !== generation.current || AppState.currentState !== 'active') return;
      if (Platform.OS === 'web') {
        await Linking.openURL(`${origin}/accessible-pour-moi`);
        return;
      }
      const host = createNativeWatchHost();
      let script: string | null = null;
      if (host) {
        const token = createNativeWatchChallenge();
        currentBridge.current = createOneWebBridge(host, { origin, token,
          inject: source => web.current?.injectJavaScript(source),
          onError: status => { if (mounted.current) setMessage(status); },
        });
        script = buildOneNativeHostScript(origin, token);
      }
      loadCount.current = 0;
      setSession({ key: attempt, script });
      setMessage('Ouverture du parcours ONE…');
      deadline.current = setTimeout(() => {
        if (attempt === generation.current) void stop('Le parcours n’a pas répondu à temps. Vous pouvez réessayer.');
      }, 30_000);
    } catch {
      await stop('Le parcours n’a pas pu être ouvert. Vous pouvez vérifier la connexion et réessayer.');
    } finally {
      opening.current = false;
      if (mounted.current && generation.current === attempt) setBusy(false);
    }
  }

  async function back(destination: 'back' | 'communication' = 'back') {
    const closed = stop('Parcours fermé.');
    const attempt = generation.current;
    if (!await closed || !mounted.current || attempt !== generation.current || AppState.currentState !== 'active') return;
    if (destination === 'communication') router.replace('/communication');
    else router.back();
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    <View style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>Accessible pour moi</Text>
      <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
      {watchStatus?.state === 'awaiting-watch' && watchStatus.pairingCode && <Text accessibilityLiveRegion="polite" style={styles.message}>Comparez le code {watchStatus.pairingCode} sur les deux appareils, puis choisissez sur votre montre si vous autorisez ce lien.</Text>}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={styles.button} onPress={() => { void back(); }}><Text style={styles.buttonText}>Retour</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={styles.button} onPress={() => { void back('communication'); }}><Text style={styles.buttonText}>Communiquer par écrit</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => { void stop('Parcours et lien montre fermés. Vous pouvez les rouvrir à votre demande.'); }}><Text style={styles.buttonText}>Arrêter et fermer</Text></Pressable>
        {!session && <Pressable accessibilityRole="button" accessibilityState={{ disabled: !origin || busy }} disabled={!origin || busy} style={styles.button} onPress={() => { void open(); }}><Text style={styles.buttonText}>Ouvrir le parcours</Text></Pressable>}
        {!session && <Pressable accessibilityRole="button" style={styles.button} onPress={() => router.push('/accessibility-watch')}><Text style={styles.buttonText}>Régler ma montre</Text></Pressable>}
      </View>
    </View>
    {session && origin && <WebView key={session.key} ref={web} style={styles.web}
      source={{ uri: `${origin}/accessible-pour-moi` }}
      // Send every attempted URL to our exact route gate. A restrictive
      // originWhitelist alone opens rejected URLs through native Linking.
      originWhitelist={['*']}
      javaScriptEnabled domStorageEnabled mediaPlaybackRequiresUserAction mediaCapturePermissionGrantType="prompt"
      mixedContentMode="never" allowFileAccess={false} allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false} javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
      allowsBackForwardNavigationGestures={false} sharedCookiesEnabled={false}
      onShouldStartLoadWithRequest={request => {
        if (generation.current !== session.key) return false;
        const allowed = isOneAccessibilityUrl(request.url, origin);
        if (!allowed) setMessage('Ce lien mène hors du parcours accessible. Fermez le parcours pour changer d’écran.');
        return allowed;
      }}
      onOpenWindow={() => { if (generation.current === session.key) setMessage('L’ouverture d’une autre fenêtre est désactivée dans ce parcours.'); }}
      onLoadStart={() => {
        if (generation.current !== session.key) return;
        if (++loadCount.current > 1) void stop('Le parcours doit être rouvert après ce changement de page.');
      }}
      onLoadEnd={event => {
        if (!isOneAccessibilityUrl(event.nativeEvent.url, origin) || loadCount.current !== 1
          || generation.current !== session.key) return;
        if (deadline.current) clearTimeout(deadline.current);
        deadline.current = undefined;
        if (session.script) web.current?.injectJavaScript(session.script);
        setMessage(session.script ? 'Parcours ouvert. Les capteurs et la montre restent sous votre contrôle.'
          : 'Parcours ouvert. Le lien natif avec la montre n’est pas disponible dans cette version.');
      }}
      onMessage={event => { if (generation.current === session.key) void currentBridge.current?.receive(event.nativeEvent.data, event.nativeEvent.url); }}
      onError={() => { if (generation.current === session.key) void stop('Le parcours n’a pas pu être chargé. Vous pouvez réessayer.'); }}
      onHttpError={event => { if (generation.current === session.key && isOneAccessibilityUrl(event.nativeEvent.url, origin) && event.nativeEvent.statusCode >= 400) void stop('Le parcours est momentanément indisponible. Vous pouvez réessayer.'); }}
      onContentProcessDidTerminate={() => { if (generation.current === session.key) void stop('Le parcours s’est interrompu. Rouvrez-le pour continuer.'); }}
      onRenderProcessGone={() => { if (generation.current === session.key) void stop('Le parcours s’est interrompu. Rouvrez-le pour continuer.'); }}
    />}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0F' },
  header: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  title: { color: '#FFFFFF', fontSize: 22, fontWeight: '700' },
  message: { color: '#E5E5EF', fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: '#BDB3D1', borderRadius: 12, backgroundColor: '#22202A' },
  buttonText: { color: '#FFFFFF', fontSize: 16 },
  web: { flex: 1, backgroundColor: '#14141C' },
});
