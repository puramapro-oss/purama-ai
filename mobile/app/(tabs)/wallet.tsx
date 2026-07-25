import { View, Text, ScrollView, RefreshControl, Alert, FlatList } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { useWallet } from "@/hooks/useWallet";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatPrice, formatDate } from "@/lib/utils";
import { COLORS } from "@/lib/constants";

export default function WalletScreen() {
  const { balance, transactions, loading, refresh, requestWithdrawal } = useWallet();
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [amount, setAmount] = useState("");
  const [iban, setIban] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);

  const handleWithdraw = async () => {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 5) {
      Alert.alert("Erreur", "Le montant minimum est de 5 euros");
      return;
    }
    if (!iban.trim()) {
      Alert.alert("Erreur", "Entre ton IBAN");
      return;
    }
    setWithdrawing(true);
    const { error } = await requestWithdrawal(numAmount, iban.trim());
    setWithdrawing(false);
    if (error) {
      Alert.alert("Erreur", error);
    } else {
      Alert.alert("Demande envoyee", "Ton retrait est en cours de traitement.");
      setShowWithdraw(false);
      setAmount("");
      setIban("");
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
      <ScrollView
        className="flex-1 px-4"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={COLORS.accent} />}
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-white text-2xl font-bold mt-2 mb-6">Wallet</Text>

        {/* Balance */}
        <GlassCard className="mb-6 items-center py-8">
          <Text className="text-white/50 text-sm">Solde disponible</Text>
          <Text className="text-white text-4xl font-bold mt-2">{formatPrice(balance)}</Text>
          <Text className="text-white/30 text-xs mt-2">Retrait des 5 euros via IBAN</Text>
          {balance >= 5 && (
            <Button
              testID="withdraw-btn"
              title="Retirer"
              onPress={() => setShowWithdraw(!showWithdraw)}
              className="mt-4"
            />
          )}
        </GlassCard>

        {/* Withdraw form */}
        {showWithdraw && (
          <GlassCard className="mb-6">
            <Text className="text-white font-semibold mb-4">Demande de retrait</Text>
            <Input
              testID="withdraw-amount"
              label="Montant"
              placeholder="5.00"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
            />
            <Input
              testID="withdraw-iban"
              label="IBAN"
              placeholder="FR76 ..."
              value={iban}
              onChangeText={setIban}
              autoCapitalize="characters"
            />
            <Button
              testID="withdraw-confirm"
              title="Confirmer le retrait"
              onPress={handleWithdraw}
              loading={withdrawing}
            />
          </GlassCard>
        )}

        {/* Transactions */}
        <Text className="text-white text-lg font-bold mb-3">Historique</Text>
        {transactions.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="Aucune transaction"
            description="Tes transactions apparaitront ici"
          />
        ) : (
          transactions.map((tx) => (
            <GlassCard key={tx.id} className="mb-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center gap-3">
                  <View className={`w-8 h-8 rounded-full items-center justify-center ${tx.amount > 0 ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
                    <Ionicons
                      name={tx.amount > 0 ? "arrow-down" : "arrow-up"}
                      size={16}
                      color={tx.amount > 0 ? "#10B981" : "#EF4444"}
                    />
                  </View>
                  <View>
                    <Text className="text-white text-sm font-medium">{tx.description || tx.type}</Text>
                    <Text className="text-white/30 text-xs">{formatDate(tx.created_at)}</Text>
                  </View>
                </View>
                <Text className={`font-bold ${tx.amount > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {tx.amount > 0 ? "+" : ""}{formatPrice(tx.amount)}
                </Text>
              </View>
            </GlassCard>
          ))
        )}

        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
