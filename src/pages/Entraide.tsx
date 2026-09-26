// Page Entraide — réseau d'entraide entre membres Purama AI (mise en relation, missions collectives, contact sécurisé).
// Vocabulaire adapté domaine assistant généraliste (Loi 12) : "coup de main", "partage", "réseau d'entraide".
// Design GOD MODE V3 (glass, dark mode, tokens §4), responsive 375px, VRAIS fetch (0 mock), loading/error/empty states.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  UsersRound,
  UserPlus,
  MessageSquare,
  Calendar,
  MapPin,
  Star,
  AlertCircle,
  Loader2,
  Send,
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const DAYS_FR: Record<string, string> = {
  mon: 'Lun',
  tue: 'Mar',
  wed: 'Mer',
  thu: 'Jeu',
  fri: 'Ven',
  sat: 'Sam',
  sun: 'Dim',
};

interface ProfileUpdate {
  skills_offered: string[];
  skills_needed: string[];
  availability_days: string[];
  radius_km: number | null;
}

interface MutualAidMatch {
  userId: string;
  score: number;
  reasons: string[];
}

interface CollectiveMission {
  id: string;
  title: string;
  description: string;
  status: string;
  min_participants: number;
  max_participants: number | null;
  missions_collectives_participants?: Array<{ user_id: string }>;
}

interface ContactRequest {
  id: string;
  status: string;
  requester_id: string;
  recipient_id: string;
  created_at: string;
}

export default function Entraide() {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'profil' | 'missions' | 'contacts'>('profil');
  const [missionTitle, setMissionTitle] = useState('');
  const [missionDescription, setMissionDescription] = useState('');

  const token = session?.access_token ? `Bearer ${session.access_token}` : null;

  const {
    data: profilData,
    isLoading: profilLoading,
    error: profilError,
  } = useQuery({
    queryKey: ['entraide-profil', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-profil`, {
        headers: { Authorization: token },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token,
  });

  const {
    data: matchesData,
    isLoading: matchesLoading,
    error: matchesError,
  } = useQuery({
    queryKey: ['entraide-matches', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-matches`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token && activeTab === 'profil',
  });

  const {
    data: missionsData,
    isLoading: missionsLoading,
    error: missionsError,
  } = useQuery({
    queryKey: ['entraide-missions', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-missions`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token && activeTab === 'missions',
  });

  const {
    data: contactsData,
    isLoading: contactsLoading,
    error: contactsError,
  } = useQuery({
    queryKey: ['entraide-contacts', user?.id],
    queryFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-contact`,
        { headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!user && !!token && activeTab === 'contacts',
  });

  const updateProfilMutation = useMutation({
    mutationFn: async (data: ProfileUpdate) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-profil`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-profil'] });
      toast.success('Profil mis à jour');
    },
    onError: (error: Error) => {
      toast.error(`Erreur: ${error.message}`);
    },
  });

  const sendContactMutation = useMutation({
    mutationFn: async (recipientId: string) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-contact`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_id: recipientId,
          message: "Bonjour, j’aimerais échanger avec vous dans le réseau d’entraide PURAMA AI.",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-contacts'] });
      toast.success('Demande de contact envoyée');
    },
    onError: (error: Error) => toast.error(`Erreur: ${error.message}`),
  });

  const respondContactMutation = useMutation({
    mutationFn: async ({ requestId, response }: { requestId: string; response: 'accept' | 'decline' | 'block' }) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-contact/${requestId}/respond`,
        {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ response }),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-contacts'] });
      toast.success('Demande mise à jour');
    },
    onError: (error: Error) => toast.error(`Erreur: ${error.message}`),
  });

  const createMissionMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-missions`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: missionTitle.trim(),
          description: missionDescription.trim(),
          min_participants: 2,
          max_participants: null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      setMissionTitle('');
      setMissionDescription('');
      queryClient.invalidateQueries({ queryKey: ['entraide-missions'] });
      toast.success('Mission collective créée');
    },
    onError: (error: Error) => toast.error(`Erreur: ${error.message}`),
  });

  const joinMissionMutation = useMutation({
    mutationFn: async (missionId: string) => {
      if (!token) throw new Error('Non authentifié');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/entraide-missions/${missionId}/join`,
        { method: 'POST', headers: { Authorization: token } }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entraide-missions'] });
      toast.success('Mission rejointe');
    },
    onError: (error: Error) => toast.error(`Erreur: ${error.message}`),
  });

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="max-w-md w-full glass-brutal">
          <CardContent className="p-6 text-center space-y-4">
            <Shield className="w-12 h-12 mx-auto text-red-400" />
            <p className="text-muted-foreground">Connecte-toi pour accéder au réseau d'entraide.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs = [
    { id: 'profil' as const, label: 'Mon Profil', icon: UsersRound },
    { id: 'missions' as const, label: 'Missions Collectives', icon: Users },
    { id: 'contacts' as const, label: 'Mes Contacts', icon: MessageSquare },
  ];

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-2"
        >
          <h1 className="text-3xl md:text-4xl font-orbitron font-bold text-foreground">
            Réseau d'Entraide
          </h1>
          <p className="text-muted-foreground">
            Trouve des membres pour t'entraider, rejoins des missions collectives, échange en sécurité.
          </p>
        </motion.div>

        <div className="flex gap-2 overflow-x-auto pb-2">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              variant={activeTab === tab.id ? 'default' : 'outline'}
              className="flex-shrink-0"
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.icon className="w-4 h-4 mr-2" />
              {tab.label}
            </Button>
          ))}
        </div>

        {activeTab === 'profil' && (
          <div className="space-y-6">
            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UsersRound className="w-5 h-5" />
                  Ton Profil d'Entraide
                </CardTitle>
              </CardHeader>
              <CardContent>
                {profilLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : profilError ? (
                  <div className="text-center py-8 space-y-2">
                    <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                    <p className="text-muted-foreground">
                      Erreur: {profilError instanceof Error ? profilError.message : 'Inconnue'}
                    </p>
                  </div>
                ) : !profilData?.profil ? (
                  <div className="text-center py-8 space-y-4">
                    <p className="text-muted-foreground">Tu n'as pas encore de profil d'entraide.</p>
                    <Button
                      onClick={() => {
                        updateProfilMutation.mutate({
                          skills_offered: [],
                          skills_needed: [],
                          availability_days: [],
                        });
                      }}
                    >
                      Créer mon profil
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Compétences offertes:</p>
                      <p className="text-foreground">
                        {profilData.profil.skills_offered?.length > 0
                          ? profilData.profil.skills_offered.join(', ')
                          : 'Aucune'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Compétences recherchées:</p>
                      <p className="text-foreground">
                        {profilData.profil.skills_needed?.length > 0
                          ? profilData.profil.skills_needed.join(', ')
                          : 'Aucune'}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Disponibilité:</p>
                      <p className="text-foreground">
                        {profilData.profil.availability_days?.length > 0
                          ? profilData.profil.availability_days.map((d: string) => DAYS_FR[d] || d).join(', ')
                          : 'Non renseignée'}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Star className="w-5 h-5" />
                  Suggestions de Membres ({matchesData?.matches?.length ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {matchesLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : matchesError ? (
                  <div className="text-center py-8 space-y-2">
                    <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                    <p className="text-muted-foreground">
                      Erreur: {matchesError instanceof Error ? matchesError.message : 'Inconnue'}
                    </p>
                  </div>
                ) : !matchesData?.matches || matchesData.matches.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground">
                      Aucune suggestion pour l'instant. Complete ton profil pour améliorer les matchs!
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {matchesData.matches.slice(0, 10).map((match: MutualAidMatch) => (
                      <div
                        key={match.userId}
                        className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <UserPlus className="w-5 h-5 text-primary" />
                          <div>
                            <p className="text-sm font-medium">Membre {match.userId.slice(0, 8)}</p>
                            <p className="text-xs text-muted-foreground">
                              Score: {match.score}/100 • {match.reasons.join(', ')}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={sendContactMutation.isPending}
                          onClick={() => sendContactMutation.mutate(match.userId)}
                        >
                          <Send className="w-4 h-4 mr-1" />
                          Contacter
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'missions' && (
          <div className="space-y-4">
            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle>Créer une mission collective</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  value={missionTitle}
                  onChange={(event) => setMissionTitle(event.target.value)}
                  placeholder="Titre de la mission"
                  maxLength={200}
                />
                <textarea aria-label="Décris le coup de main collectif"
                  value={missionDescription}
                  onChange={(event) => setMissionDescription(event.target.value)}
                  placeholder="Décris le coup de main collectif"
                  maxLength={2000}
                  className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <Button
                  disabled={!missionTitle.trim() || createMissionMutation.isPending}
                  onClick={() => createMissionMutation.mutate()}
                >
                  {createMissionMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Créer à partir de 2 membres'}
                </Button>
              </CardContent>
            </Card>
            <Card className="glass-brutal">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Missions Collectives ({missionsData?.missions?.length ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
              {missionsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : missionsError ? (
                <div className="text-center py-8 space-y-2">
                  <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                  <p className="text-muted-foreground">
                    Erreur: {missionsError instanceof Error ? missionsError.message : 'Inconnue'}
                  </p>
                </div>
              ) : !missionsData?.missions || missionsData.missions.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">Aucune mission collective active pour l'instant.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {missionsData.missions.map((mission: CollectiveMission) => (
                    <div
                      key={mission.id}
                      className="p-4 rounded-lg bg-secondary/30 space-y-2"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-semibold text-foreground">{mission.title}</h4>
                          <p className="text-sm text-muted-foreground">{mission.description}</p>
                        </div>
                        <Badge>{mission.status}</Badge>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {mission.missions_collectives_participants?.length ?? 0}/{mission.max_participants ?? '∞'}
                        </span>
                        <span>Min: {mission.min_participants}</span>
                      </div>
                      {mission.status !== 'terminee' &&
                        mission.status !== 'annulee' &&
                        !mission.missions_collectives_participants?.some(
                          (participant: { user_id: string }) => participant.user_id === user.id
                        ) && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={joinMissionMutation.isPending}
                            onClick={() => joinMissionMutation.mutate(mission.id)}
                          >
                            Rejoindre
                          </Button>
                        )}
                    </div>
                  ))}
                </div>
              )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'contacts' && (
          <Card className="glass-brutal">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                Mes Demandes de Contact ({contactsData?.requests?.length ?? 0})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contactsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : contactsError ? (
                <div className="text-center py-8 space-y-2">
                  <AlertCircle className="w-8 h-8 mx-auto text-red-400" />
                  <p className="text-muted-foreground">
                    Erreur: {contactsError instanceof Error ? contactsError.message : 'Inconnue'}
                  </p>
                </div>
              ) : !contactsData?.requests || contactsData.requests.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">Aucune demande de contact pour l'instant.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {contactsData.requests.map((request: ContactRequest) => (
                    <div
                      key={request.id}
                      className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        {request.status === 'pending' ? (
                          <Clock className="w-5 h-5 text-yellow-400" />
                        ) : request.status === 'accepted' ? (
                          <CheckCircle className="w-5 h-5 text-green-400" />
                        ) : (
                          <XCircle className="w-5 h-5 text-red-400" />
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {request.requester_id === user?.id ? 'Envoyée' : 'Reçue'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Statut: {request.status} • {new Date(request.created_at).toLocaleDateString('fr-FR')}
                          </p>
                        </div>
                      </div>
                      {request.status === 'pending' && request.recipient_id === user.id ? (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={respondContactMutation.isPending}
                            onClick={() => respondContactMutation.mutate({ requestId: request.id, response: 'accept' })}
                          >
                            Accepter
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={respondContactMutation.isPending}
                            onClick={() => respondContactMutation.mutate({ requestId: request.id, response: 'decline' })}
                          >
                            Refuser
                          </Button>
                        </div>
                      ) : (
                        <Badge>{request.status}</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
