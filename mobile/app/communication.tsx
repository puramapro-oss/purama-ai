import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import {
  AccessibilityInfo, BackHandler, Keyboard, KeyboardAvoidingView, Platform, ScrollView,
  Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Button } from "@/components/ui/Button";
import { COLORS } from "@/lib/constants";
import { boundCommunicationText, COMMUNICATION_TEXT_LIMIT } from "@/lib/local-communication";

type Mode = "write" | "show" | "confirm-clear";
type FocusTarget = "input" | "message" | "clear" | "confirmation";

export default function CommunicationScreen() {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<Mode>("write");
  const [extraLarge, setExtraLarge] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ target: FocusTarget; revision: number } | null>(null);
  const input = useRef<TextInput>(null);
  const displayedMessage = useRef<Text>(null);
  const clearButton = useRef<ComponentRef<typeof TouchableOpacity>>(null);
  const confirmationTitle = useRef<Text>(null);
  const previousMode = useRef<"write" | "show">("write");

  const requestFocus = useCallback((target: FocusTarget) => {
    setFocusRequest(current => ({ target, revision: (current?.revision ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!focusRequest) return;
    const target = focusRequest.target === "input" ? input.current
      : focusRequest.target === "message" ? displayedMessage.current
      : focusRequest.target === "clear" ? clearButton.current : confirmationTitle.current;
    if (!target) return;
    if (focusRequest.target === "input") input.current?.focus();
    if (Platform.OS === "web") {
      // RN Web exposes DOM refs; its AccessibilityInfo focus methods are no-ops.
      if (focusRequest.target !== "input" && typeof target.focus === "function") target.focus();
    } else if (typeof AccessibilityInfo.sendAccessibilityEvent === "function") {
      AccessibilityInfo.sendAccessibilityEvent(target, "focus");
    }
  }, [focusRequest]);

  useFocusEffect(useCallback(() => () => {
    // A screen retained in the navigation stack must not retain its conversation.
    setDraft("");
    setMessage("");
    setMode("write");
    setFocusRequest(null);
  }, []));

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (mode === "confirm-clear") {
        setMode(previousMode.current);
        requestFocus("clear");
        return true;
      }
      if (mode === "show") {
        setMode("write");
        requestFocus("input");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [mode, requestFocus]));

  const showMessage = () => {
    const next = draft;
    if (!next.trim()) return;
    Keyboard.dismiss();
    setMessage(next);
    setMode("show");
    requestFocus("message");
  };

  const askToClear = () => {
    if (!draft && !message) return;
    Keyboard.dismiss();
    previousMode.current = mode === "show" ? "show" : "write";
    setMode("confirm-clear");
    requestFocus("confirmation");
  };

  const cancelClear = () => {
    setMode(previousMode.current);
    requestFocus("clear");
  };

  const confirmClear = () => {
    setDraft("");
    setMessage("");
    setMode("write");
    requestFocus("input");
  };

  const actionStyle = { minHeight: 56 };
  const actionTextStyle = { fontSize: 20, textAlign: "center" as const };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 20 }}
          keyboardShouldPersistTaps="handled"
        >
          {mode === "confirm-clear" ? (
            <>
              <Text ref={confirmationTitle} testID="communication-clear-title" accessible accessibilityRole="header"
                {...(Platform.OS === "web" ? { tabIndex: -1 } : {})}
                style={{ color: COLORS.text, fontSize: 28, fontWeight: "700" }}>
                Effacer tout le texte ?
              </Text>
              <Text style={{ color: COLORS.text, fontSize: 20, lineHeight: 30 }}>
                Le brouillon et le message affiché seront effacés de cet écran.
              </Text>
              <Button testID="communication-keep" title="Conserver le texte" onPress={cancelClear}
                style={actionStyle} textStyle={actionTextStyle} />
              <Button testID="communication-confirm-clear" title="Effacer le texte" variant="secondary"
                onPress={confirmClear} style={actionStyle} textStyle={actionTextStyle} />
            </>
          ) : (
            <>
              <Button testID="communication-home" title="Accueil" variant="secondary"
                accessibilityHint="Quitte cet écran et efface son texte."
                onPress={() => router.replace("/")} style={actionStyle} textStyle={actionTextStyle} />
              <Text accessibilityRole="header" style={{ color: COLORS.text, fontSize: 28, fontWeight: "700" }}>
                Communiquer par écrit
              </Text>
              {mode === "write" ? (
                <>
                  <Text style={{ color: COLORS.text, fontSize: 20, lineHeight: 30 }}>
                    Écrivez votre message, puis choisissez « Afficher en grand ».
                  </Text>
                  <TextInput
                    ref={input}
                    testID="communication-input"
                    accessibilityLabel="Votre message"
                    accessibilityHint="Zone de texte sur plusieurs lignes. Le message sera montré après votre choix."
                    placeholder="Écrivez ici"
                    placeholderTextColor={COLORS.textSecondary}
                    selectionColor={COLORS.accentLight}
                    value={draft}
                    onChangeText={value => setDraft(boundCommunicationText(value))}
                    multiline
                    maxLength={COMMUNICATION_TEXT_LIMIT}
                    autoComplete="off"
                    autoCorrect={false}
                    spellCheck={false}
                    importantForAutofill="no"
                    textAlignVertical="top"
                    style={{ minHeight: 180, padding: 16, borderRadius: 12, borderWidth: 2,
                      borderColor: COLORS.textSecondary, backgroundColor: COLORS.surface,
                      color: COLORS.text, fontSize: 24, lineHeight: 34 }}
                  />
                  <Button testID="communication-show" title="Afficher en grand" disabled={!draft.trim()}
                    onPress={showMessage} style={actionStyle} textStyle={actionTextStyle} />
                </>
              ) : (
                <>
                  <Text ref={displayedMessage} testID="communication-message" accessible selectable
                    {...(Platform.OS === "web" ? { tabIndex: -1 } : {})}
                    style={{ color: COLORS.text, fontSize: extraLarge ? 48 : 32,
                      lineHeight: extraLarge ? 64 : 44, paddingVertical: 16 }}>
                    {message}
                  </Text>
                  <Button testID="communication-size" title={extraLarge ? "Revenir au grand texte" : "Agrandir encore le texte"}
                    variant="secondary" accessibilityState={{ selected: extraLarge }}
                    onPress={() => setExtraLarge(current => !current)} style={actionStyle} textStyle={actionTextStyle} />
                  <Button testID="communication-edit" title="Modifier le message" variant="secondary"
                    onPress={() => { setMode("write"); requestFocus("input"); }}
                    style={actionStyle} textStyle={actionTextStyle} />
                </>
              )}
              <Button ref={clearButton} testID="communication-clear" title="Effacer le texte"
                disabled={!draft && !message} variant="secondary" onPress={askToClear}
                style={actionStyle} textStyle={actionTextStyle} />
              <View style={{ gap: 8 }}>
                <Text style={{ color: COLORS.textSecondary, fontSize: 17, lineHeight: 26 }}>
                  Cette fonction n’enregistre pas votre texte et ne l’envoie pas. Le texte est effacé quand vous quittez cet écran.
                </Text>
                <Text style={{ color: COLORS.textSecondary, fontSize: 17, lineHeight: 26 }}>
                  Vous pouvez utiliser les réglages de taille du texte et le lecteur d’écran de votre téléphone.
                </Text>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
