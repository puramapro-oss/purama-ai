export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  purama_ai: {
    Tables: {
      connect_accounts: {
        Row: {
          charges_enabled: boolean | null
          country: string | null
          created_at: string | null
          kyc_verified_at: string | null
          onboarding_completed: boolean | null
          payouts_enabled: boolean | null
          requirements: Json | null
          stripe_account_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          charges_enabled?: boolean | null
          country?: string | null
          created_at?: string | null
          kyc_verified_at?: string | null
          onboarding_completed?: boolean | null
          payouts_enabled?: boolean | null
          requirements?: Json | null
          stripe_account_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          charges_enabled?: boolean | null
          country?: string | null
          created_at?: string | null
          kyc_verified_at?: string | null
          onboarding_completed?: boolean | null
          payouts_enabled?: boolean | null
          requirements?: Json | null
          stripe_account_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      cross_promos: {
        Row: {
          coupon_code: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          source_app: string
          target_app: string
          target_color: string | null
          target_description: string | null
          target_icon: string | null
          target_name: string
          target_url: string
        }
        Insert: {
          coupon_code?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          source_app: string
          target_app: string
          target_color?: string | null
          target_description?: string | null
          target_icon?: string | null
          target_name: string
          target_url: string
        }
        Update: {
          coupon_code?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          source_app?: string
          target_app?: string
          target_color?: string | null
          target_description?: string | null
          target_icon?: string | null
          target_name?: string
          target_url?: string
        }
        Relationships: []
      }
      daily_gifts: {
        Row: {
          gift_type: string
          gift_value: string
          id: string
          opened_at: string | null
          streak_count: number | null
          user_id: string
        }
        Insert: {
          gift_type: string
          gift_value: string
          id?: string
          opened_at?: string | null
          streak_count?: number | null
          user_id: string
        }
        Update: {
          gift_type?: string
          gift_value?: string
          id?: string
          opened_at?: string | null
          streak_count?: number | null
          user_id?: string
        }
        Relationships: []
      }
      faq_articles: {
        Row: {
          answer: string
          category: string
          created_at: string | null
          helpful_count: number | null
          id: string
          question: string
          search_keywords: string[] | null
          sort_order: number | null
          view_count: number | null
        }
        Insert: {
          answer: string
          category: string
          created_at?: string | null
          helpful_count?: number | null
          id?: string
          question: string
          search_keywords?: string[] | null
          sort_order?: number | null
          view_count?: number | null
        }
        Update: {
          answer?: string
          category?: string
          created_at?: string | null
          helpful_count?: number | null
          id?: string
          question?: string
          search_keywords?: string[] | null
          sort_order?: number | null
          view_count?: number | null
        }
        Relationships: []
      }
      lottery_draws: {
        Row: {
          created_at: string | null
          draw_date: string
          id: string
          pool_amount: number | null
          status: string
        }
        Insert: {
          created_at?: string | null
          draw_date: string
          id?: string
          pool_amount?: number | null
          status?: string
        }
        Update: {
          created_at?: string | null
          draw_date?: string
          id?: string
          pool_amount?: number | null
          status?: string
        }
        Relationships: []
      }
      lottery_tickets: {
        Row: { created_at: string | null; draw_id: string | null; id: string; source: string; user_id: string }
        Insert: { created_at?: string | null; draw_id?: string | null; id?: string; source: string; user_id: string }
        Update: { created_at?: string | null; draw_id?: string | null; id?: string; source?: string; user_id?: string }
        Relationships: []
      }
      lottery_winners: {
        Row: { amount_won: number; created_at: string | null; draw_id: string; id: string; rank: number; ticket_id: string | null; user_id: string }
        Insert: { amount_won: number; created_at?: string | null; draw_id: string; id?: string; rank: number; ticket_id?: string | null; user_id: string }
        Update: { amount_won?: number; created_at?: string | null; draw_id?: string; id?: string; rank?: number; ticket_id?: string | null; user_id?: string }
        Relationships: []
      }
      point_purchases: {
        Row: { created_at: string | null; id: string; item_id: string | null; points_spent: number; user_id: string }
        Insert: { created_at?: string | null; id?: string; item_id?: string | null; points_spent: number; user_id: string }
        Update: { created_at?: string | null; id?: string; item_id?: string | null; points_spent?: number; user_id?: string }
        Relationships: []
      }
      point_shop_items: {
        Row: { category: string; cost_points: number; created_at: string | null; description: string | null; id: string; is_active: boolean | null; name: string; type: string; value: string | null }
        Insert: { category: string; cost_points: number; created_at?: string | null; description?: string | null; id?: string; is_active?: boolean | null; name: string; type: string; value?: string | null }
        Update: { category?: string; cost_points?: number; created_at?: string | null; description?: string | null; id?: string; is_active?: boolean | null; name?: string; type?: string; value?: string | null }
        Relationships: []
      }
      point_transactions: {
        Row: { amount: number; created_at: string | null; description: string | null; id: string; source: string; type: string; user_id: string }
        Insert: { amount: number; created_at?: string | null; description?: string | null; id?: string; source: string; type: string; user_id: string }
        Update: { amount?: number; created_at?: string | null; description?: string | null; id?: string; source?: string; type?: string; user_id?: string }
        Relationships: []
      }
      purama_points: {
        Row: { balance: number | null; created_at: string | null; id: string; last_active_date: string | null; lifetime_earned: number | null; streak_days: number | null; streak_multiplier: number | null; updated_at: string | null; user_id: string }
        Insert: { balance?: number | null; created_at?: string | null; id?: string; last_active_date?: string | null; lifetime_earned?: number | null; streak_days?: number | null; streak_multiplier?: number | null; updated_at?: string | null; user_id: string }
        Update: { balance?: number | null; created_at?: string | null; id?: string; last_active_date?: string | null; lifetime_earned?: number | null; streak_days?: number | null; streak_multiplier?: number | null; updated_at?: string | null; user_id?: string }
        Relationships: []
      }
      reglements: {
        Row: { blockchain: string | null; content_hash: string; content_markdown: string | null; content_url: string | null; id: string; metadata: Json | null; opentimestamps_proof: string | null; published_at: string | null; type: string; version: string }
        Insert: { blockchain?: string | null; content_hash: string; content_markdown?: string | null; content_url?: string | null; id?: string; metadata?: Json | null; opentimestamps_proof?: string | null; published_at?: string | null; type?: string; version: string }
        Update: { blockchain?: string | null; content_hash?: string; content_markdown?: string | null; content_url?: string | null; id?: string; metadata?: Json | null; opentimestamps_proof?: string | null; published_at?: string | null; type?: string; version?: string }
        Relationships: []
      }
      user_tax_profiles: {
        Row: { activity_type: string | null; company_name: string | null; edi_tdfc_enabled: boolean | null; legal_form: string | null; onboarded_at: string | null; pennylane_company_id: string | null; pennylane_oauth_token_encrypted: string | null; profile_type: string | null; siren: string | null; siret: string | null; threshold_305_alerted: boolean | null; threshold_bnc_alerted: boolean | null; threshold_tva_alerted: boolean | null; tva_franchise: boolean | null; updated_at: string | null; urssaf_mandate_doc_id: string | null; urssaf_mandate_signed_at: string | null; user_id: string }
        Insert: { activity_type?: string | null; company_name?: string | null; edi_tdfc_enabled?: boolean | null; legal_form?: string | null; onboarded_at?: string | null; pennylane_company_id?: string | null; pennylane_oauth_token_encrypted?: string | null; profile_type?: string | null; siren?: string | null; siret?: string | null; threshold_305_alerted?: boolean | null; threshold_bnc_alerted?: boolean | null; threshold_tva_alerted?: boolean | null; tva_franchise?: boolean | null; updated_at?: string | null; urssaf_mandate_doc_id?: string | null; urssaf_mandate_signed_at?: string | null; user_id: string }
        Update: { activity_type?: string | null; company_name?: string | null; edi_tdfc_enabled?: boolean | null; legal_form?: string | null; onboarded_at?: string | null; pennylane_company_id?: string | null; pennylane_oauth_token_encrypted?: string | null; profile_type?: string | null; siren?: string | null; siret?: string | null; threshold_305_alerted?: boolean | null; threshold_bnc_alerted?: boolean | null; threshold_tva_alerted?: boolean | null; tva_franchise?: boolean | null; updated_at?: string | null; urssaf_mandate_doc_id?: string | null; urssaf_mandate_signed_at?: string | null; user_id?: string }
        Relationships: []
      }
      wallets: {
        Row: { balance: number | null; created_at: string | null; id: string; total_earned: number | null; total_withdrawn: number | null; updated_at: string | null; user_id: string }
        Insert: { balance?: number | null; created_at?: string | null; id?: string; total_earned?: number | null; total_withdrawn?: number | null; updated_at?: string | null; user_id: string }
        Update: { balance?: number | null; created_at?: string | null; id?: string; total_earned?: number | null; total_withdrawn?: number | null; updated_at?: string | null; user_id?: string }
        Relationships: []
      }
      wallet_transactions: {
        Row: { amount: number; created_at: string | null; description: string | null; id: string; source: string; type: string; user_id: string }
        Insert: { amount: number; created_at?: string | null; description?: string | null; id?: string; source: string; type: string; user_id: string }
        Update: { amount?: number; created_at?: string | null; description?: string | null; id?: string; source?: string; type?: string; user_id?: string }
        Relationships: []
      }
      withdrawals: {
        Row: { amount: number; beneficiary_name: string; iban: string; id: string; processed_at: string | null; requested_at: string | null; status: string; user_id: string }
        Insert: { amount: number; beneficiary_name: string; iban: string; id?: string; processed_at?: string | null; requested_at?: string | null; status?: string; user_id: string }
        Update: { amount?: number; beneficiary_name?: string; iban?: string; id?: string; processed_at?: string | null; requested_at?: string | null; status?: string; user_id?: string }
        Relationships: []
      }
      agent_usage: {
        Row: {
          action_type: string
          agent_id: string
          created_at: string | null
          id: string
          metadata: Json | null
          status: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          agent_id: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          status?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          agent_id?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_usage_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          category: string
          color: string | null
          created_at: string | null
          description: string | null
          features: Json | null
          icon: string | null
          id: string
          is_active: boolean | null
          is_premium: boolean | null
          name: string
          slug: string
          webhook_slug: string | null
        }
        Insert: {
          category: string
          color?: string | null
          created_at?: string | null
          description?: string | null
          features?: Json | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          name: string
          slug: string
          webhook_slug?: string | null
        }
        Update: {
          category?: string
          color?: string | null
          created_at?: string | null
          description?: string | null
          features?: Json | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          name?: string
          slug?: string
          webhook_slug?: string | null
        }
        Relationships: []
      }
      candidatures_classement: {
        Row: {
          agents_utilises: string[] | null
          analyse_ia: string | null
          categorie_impact: string | null
          classement_id: string
          created_at: string | null
          description_impact: string
          gains: number | null
          id: string
          rang: number | null
          score_ia: number | null
          site_url: string
          user_id: string
          verifie_agents: boolean | null
        }
        Insert: {
          agents_utilises?: string[] | null
          analyse_ia?: string | null
          categorie_impact?: string | null
          classement_id: string
          created_at?: string | null
          description_impact: string
          gains?: number | null
          id?: string
          rang?: number | null
          score_ia?: number | null
          site_url: string
          user_id: string
          verifie_agents?: boolean | null
        }
        Update: {
          agents_utilises?: string[] | null
          analyse_ia?: string | null
          categorie_impact?: string | null
          classement_id?: string
          created_at?: string | null
          description_impact?: string
          gains?: number | null
          id?: string
          rang?: number | null
          score_ia?: number | null
          site_url?: string
          user_id?: string
          verifie_agents?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "candidatures_classement_classement_id_fkey"
            columns: ["classement_id"]
            isOneToOne: false
            referencedRelation: "classement_mensuel"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_conversations: {
        Row: {
          created_at: string
          escalated: boolean | null
          id: string
          session_id: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          escalated?: boolean | null
          id?: string
          session_id: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          escalated?: boolean | null
          id?: string
          session_id?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "chat_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      chatbot_knowledge: {
        Row: {
          categorie: string
          created_at: string
          id: string
          keywords: string[] | null
          question: string
          reponse: string
          updated_at: string
        }
        Insert: {
          categorie: string
          created_at?: string
          id?: string
          keywords?: string[] | null
          question: string
          reponse: string
          updated_at?: string
        }
        Update: {
          categorie?: string
          created_at?: string
          id?: string
          keywords?: string[] | null
          question?: string
          reponse?: string
          updated_at?: string
        }
        Relationships: []
      }
      classement_mensuel: {
        Row: {
          cagnotte: number | null
          created_at: string | null
          id: string
          mois: string
          statut: string | null
        }
        Insert: {
          cagnotte?: number | null
          created_at?: string | null
          id?: string
          mois: string
          statut?: string | null
        }
        Update: {
          cagnotte?: number | null
          created_at?: string | null
          id?: string
          mois?: string
          statut?: string | null
        }
        Relationships: []
      }
      commissions: {
        Row: {
          client_id: string
          commission_amount: number
          created_at: string | null
          id: string
          influencer_id: string
          payment_date: string | null
          sale_amount: number
          status: string | null
          subscription_id: string | null
        }
        Insert: {
          client_id: string
          commission_amount: number
          created_at?: string | null
          id?: string
          influencer_id: string
          payment_date?: string | null
          sale_amount: number
          status?: string | null
          subscription_id?: string | null
        }
        Update: {
          client_id?: string
          commission_amount?: number
          created_at?: string | null
          id?: string
          influencer_id?: string
          payment_date?: string | null
          sale_amount?: number
          status?: string | null
          subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commissions_influencer_id_fkey"
            columns: ["influencer_id"]
            isOneToOne: false
            referencedRelation: "influencer_leaderboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_influencer_id_fkey"
            columns: ["influencer_id"]
            isOneToOne: false
            referencedRelation: "influencers"
            referencedColumns: ["id"]
          },
        ]
      }
      concours: {
        Row: {
          cagnotte: number | null
          created_at: string | null
          date_debut: string
          date_fin: string
          description: string | null
          gagnants: Json | null
          id: string
          pourcentage_ca: number
          statut: string | null
          titre: string
          type: string
        }
        Insert: {
          cagnotte?: number | null
          created_at?: string | null
          date_debut: string
          date_fin: string
          description?: string | null
          gagnants?: Json | null
          id?: string
          pourcentage_ca: number
          statut?: string | null
          titre: string
          type: string
        }
        Update: {
          cagnotte?: number | null
          created_at?: string | null
          date_debut?: string
          date_fin?: string
          description?: string | null
          gagnants?: Json | null
          id?: string
          pourcentage_ca?: number
          statut?: string | null
          titre?: string
          type?: string
        }
        Relationships: []
      }
      contact_submissions: {
        Row: {
          company: string | null
          created_at: string
          email: string
          id: string
          message: string
          name: string
          request_fingerprint: string
          status: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          email: string
          id?: string
          message: string
          name: string
          request_fingerprint: string
          status?: string
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string
          id?: string
          message?: string
          name?: string
          request_fingerprint?: string
          status?: string
        }
        Relationships: []
      }
      influencers: {
        Row: {
          affiliation_link: string
          beneficiary_name: string | null
          commission_rate: number | null
          commission_tier: string | null
          contract_signed_at: string | null
          contract_status: string | null
          created_at: string | null
          expires_at: string | null
          iban: string | null
          id: string
          promo_code: string
          total_revenue: number | null
          total_sales: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          affiliation_link: string
          beneficiary_name?: string | null
          commission_rate?: number | null
          commission_tier?: string | null
          contract_signed_at?: string | null
          contract_status?: string | null
          created_at?: string | null
          expires_at?: string | null
          iban?: string | null
          id?: string
          promo_code: string
          total_revenue?: number | null
          total_sales?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          affiliation_link?: string
          beneficiary_name?: string | null
          commission_rate?: number | null
          commission_tier?: string | null
          contract_signed_at?: string | null
          contract_status?: string | null
          created_at?: string | null
          expires_at?: string | null
          iban?: string | null
          id?: string
          promo_code?: string
          total_revenue?: number | null
          total_sales?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      notification_preferences: {
        Row: {
          alert_enabled: boolean | null
          created_at: string | null
          daily_report_enabled: boolean | null
          email_enabled: boolean | null
          id: string
          question_enabled: boolean | null
          task_completed_enabled: boolean | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          alert_enabled?: boolean | null
          created_at?: string | null
          daily_report_enabled?: boolean | null
          email_enabled?: boolean | null
          id?: string
          question_enabled?: boolean | null
          task_completed_enabled?: boolean | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          alert_enabled?: boolean | null
          created_at?: string | null
          daily_report_enabled?: boolean | null
          email_enabled?: boolean | null
          id?: string
          question_enabled?: boolean | null
          task_completed_enabled?: boolean | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          action_url: string | null
          agent_slug: string | null
          created_at: string | null
          id: string
          message: string
          read: boolean | null
          title: string
          type: Database["purama_ai"]["Enums"]["notification_type"]
          user_id: string
        }
        Insert: {
          action_url?: string | null
          agent_slug?: string | null
          created_at?: string | null
          id?: string
          message: string
          read?: boolean | null
          title: string
          type: Database["purama_ai"]["Enums"]["notification_type"]
          user_id: string
        }
        Update: {
          action_url?: string | null
          agent_slug?: string | null
          created_at?: string | null
          id?: string
          message?: string
          read?: boolean | null
          title?: string
          type?: Database["purama_ai"]["Enums"]["notification_type"]
          user_id?: string
        }
        Relationships: []
      }
      paliers_parrainage: {
        Row: {
          atteint_le: string | null
          id: string
          palier: number
          prime_description: string
          prime_reclamee: boolean | null
          prime_type: string
          user_id: string
        }
        Insert: {
          atteint_le?: string | null
          id?: string
          palier: number
          prime_description: string
          prime_reclamee?: boolean | null
          prime_type: string
          user_id: string
        }
        Update: {
          atteint_le?: string | null
          id?: string
          palier?: number
          prime_description?: string
          prime_reclamee?: boolean | null
          prime_type?: string
          user_id?: string
        }
        Relationships: []
      }
      participations_concours: {
        Row: {
          concours_id: string
          created_at: string | null
          id: string
          nombre_places: number | null
          source: string | null
          user_id: string
        }
        Insert: {
          concours_id: string
          created_at?: string | null
          id?: string
          nombre_places?: number | null
          source?: string | null
          user_id: string
        }
        Update: {
          concours_id?: string
          created_at?: string | null
          id?: string
          nombre_places?: number | null
          source?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "participations_concours_concours_id_fkey"
            columns: ["concours_id"]
            isOneToOne: false
            referencedRelation: "concours"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          code_parrainage: string | null
          company_name: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          gains_totaux: number | null
          id: string
          nombre_filleuls: number | null
          palier_actuel: number | null
          parraine_par: string | null
          phone: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          code_parrainage?: string | null
          company_name?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          gains_totaux?: number | null
          id?: string
          nombre_filleuls?: number | null
          palier_actuel?: number | null
          parraine_par?: string | null
          phone?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          code_parrainage?: string | null
          company_name?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          gains_totaux?: number | null
          id?: string
          nombre_filleuls?: number | null
          palier_actuel?: number | null
          parraine_par?: string | null
          phone?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      referral_commissions: {
        Row: {
          created_at: string | null
          filleul_user_id: string
          id: string
          mois: string | null
          montant: number
          parrain_user_id: string
          statut: string | null
          type: string | null
        }
        Insert: {
          created_at?: string | null
          filleul_user_id: string
          id?: string
          mois?: string | null
          montant: number
          parrain_user_id: string
          statut?: string | null
          type?: string | null
        }
        Update: {
          created_at?: string | null
          filleul_user_id?: string
          id?: string
          mois?: string | null
          montant?: number
          parrain_user_id?: string
          statut?: string | null
          type?: string | null
        }
        Relationships: []
      }
      referrals: {
        Row: {
          code_parrainage: string
          commission_premier_mois: number | null
          commission_recurrente: number | null
          created_at: string | null
          filleul_email: string | null
          filleul_user_id: string | null
          id: string
          parrain_user_id: string
          places_concours_mois: number | null
          places_concours_semaine: number | null
          statut: string | null
        }
        Insert: {
          code_parrainage: string
          commission_premier_mois?: number | null
          commission_recurrente?: number | null
          created_at?: string | null
          filleul_email?: string | null
          filleul_user_id?: string | null
          id?: string
          parrain_user_id: string
          places_concours_mois?: number | null
          places_concours_semaine?: number | null
          statut?: string | null
        }
        Update: {
          code_parrainage?: string
          commission_premier_mois?: number | null
          commission_recurrente?: number | null
          created_at?: string | null
          filleul_email?: string | null
          filleul_user_id?: string | null
          id?: string
          parrain_user_id?: string
          places_concours_mois?: number | null
          places_concours_semaine?: number | null
          statut?: string | null
        }
        Relationships: []
      }
      scheduled_tasks: {
        Row: {
          agent_id: string
          created_at: string | null
          executed_at: string | null
          id: string
          payload: Json | null
          scheduled_for: string
          status: string | null
          task_type: string
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          executed_at?: string | null
          id?: string
          payload?: Json | null
          scheduled_for: string
          status?: string | null
          task_type: string
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          executed_at?: string | null
          id?: string
          payload?: Json | null
          scheduled_for?: string
          status?: string | null
          task_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_tasks_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string | null
          has_used_trial: boolean
          id: string
          plan_type: string | null
          status: string | null
          stripe_customer_id: string | null
          trial_ends_at: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          has_used_trial?: boolean
          id?: string
          plan_type?: string | null
          status?: string | null
          stripe_customer_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          has_used_trial?: boolean
          id?: string
          plan_type?: string | null
          status?: string | null
          stripe_customer_id?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      tier_upgrade_queue: {
        Row: {
          created_at: string | null
          id: string
          influencer_id: string
          new_rate: number
          new_tier: string
          previous_tier: string
          processed: boolean | null
          total_sales: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          influencer_id: string
          new_rate: number
          new_tier: string
          previous_tier: string
          processed?: boolean | null
          total_sales: number
        }
        Update: {
          created_at?: string | null
          id?: string
          influencer_id?: string
          new_rate?: number
          new_tier?: string
          previous_tier?: string
          processed?: boolean | null
          total_sales?: number
        }
        Relationships: [
          {
            foreignKeyName: "tier_upgrade_queue_influencer_id_fkey"
            columns: ["influencer_id"]
            isOneToOne: false
            referencedRelation: "influencer_leaderboard"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_upgrade_queue_influencer_id_fkey"
            columns: ["influencer_id"]
            isOneToOne: false
            referencedRelation: "influencers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_agent_selections: {
        Row: {
          agent_id: string
          created_at: string | null
          id: string
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string | null
          id?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_agent_selections_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      user_connections: {
        Row: {
          access_token: string | null
          created_at: string | null
          id: string
          provider: string
          refresh_token: string | null
          token_expires_at: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token?: string | null
          created_at?: string | null
          id?: string
          provider: string
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string | null
          created_at?: string | null
          id?: string
          provider?: string
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["purama_ai"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role?: Database["purama_ai"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["purama_ai"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      karta_agent_state: {
        Row: {
          agent_type: string
          autonomy_level: number
          created_at: string
          id: string
          is_enabled: boolean
          kill_switch: boolean
          last_run_at: string | null
          last_run_status: string | null
          simulation_mode: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_type: string
          autonomy_level?: number
          created_at?: string
          id?: string
          is_enabled?: boolean
          kill_switch?: boolean
          last_run_at?: string | null
          last_run_status?: string | null
          simulation_mode?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_type?: string
          autonomy_level?: number
          created_at?: string
          id?: string
          is_enabled?: boolean
          kill_switch?: boolean
          last_run_at?: string | null
          last_run_status?: string | null
          simulation_mode?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karta_runs: {
        Row: {
          agent_type: string
          claude_mock: boolean
          decision: string | null
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: string
          input_summary: string | null
          mode: string
          result_summary: string | null
          started_at: string
          status: string
          tools_used: Json
          trigger_source: string | null
          trigger_type: string
          user_id: string
        }
        Insert: {
          agent_type: string
          claude_mock?: boolean
          decision?: string | null
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          input_summary?: string | null
          mode?: string
          result_summary?: string | null
          started_at?: string
          status?: string
          tools_used?: Json
          trigger_source?: string | null
          trigger_type: string
          user_id: string
        }
        Update: {
          agent_type?: string
          claude_mock?: boolean
          decision?: string | null
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          input_summary?: string | null
          mode?: string
          result_summary?: string | null
          started_at?: string
          status?: string
          tools_used?: Json
          trigger_source?: string | null
          trigger_type?: string
          user_id?: string
        }
        Relationships: []
      }
      karta_pending_actions: {
        Row: {
          agent_type: string
          created_at: string
          id: string
          resolved_at: string | null
          result_summary: string | null
          run_id: string
          status: string
          tool_name: string
          tool_params: Json
          user_id: string
        }
        Insert: {
          agent_type: string
          created_at?: string
          id?: string
          resolved_at?: string | null
          result_summary?: string | null
          run_id: string
          status?: string
          tool_name: string
          tool_params: Json
          user_id: string
        }
        Update: {
          agent_type?: string
          created_at?: string
          id?: string
          resolved_at?: string | null
          result_summary?: string | null
          run_id?: string
          status?: string
          tool_name?: string
          tool_params?: Json
          user_id?: string
        }
        Relationships: []
      }
      karta_agent_memory: {
        Row: {
          agent_type: string
          id: string
          memory_key: string
          memory_value: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_type: string
          id?: string
          memory_key: string
          memory_value: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_type?: string
          id?: string
          memory_key?: string
          memory_value?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      karta_global_state: {
        Row: {
          id: string
          kill_switch: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: string
          kill_switch?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: string
          kill_switch?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      karta_crm_leads: {
        Row: {
          company: string | null
          created_at: string
          email: string | null
          id: string
          last_contact_at: string | null
          name: string
          next_follow_up_at: string | null
          notes: string | null
          phone: string | null
          score: number | null
          source: string | null
          stage: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          last_contact_at?: string | null
          name: string
          next_follow_up_at?: string | null
          notes?: string | null
          phone?: string | null
          score?: number | null
          source?: string | null
          stage?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company?: string | null
          created_at?: string
          email?: string | null
          id?: string
          last_contact_at?: string | null
          name?: string
          next_follow_up_at?: string | null
          notes?: string | null
          phone?: string | null
          score?: number | null
          source?: string | null
          stage?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      influencer_leaderboard: {
        Row: {
          beneficiary_name: string | null
          commission_rate: number | null
          commission_tier: string | null
          created_at: string | null
          id: string | null
          rank: number | null
          total_revenue: number | null
          total_sales: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      submit_contact: {
        Args: {
          p_company: string
          p_email: string
          p_message: string
          p_name: string
          p_started_at: string
          p_website: string
        }
        Returns: string
      }
      generate_promo_code: {
        Args: { influencer_name: string }
        Returns: string
      }
      has_role: {
        Args: {
          _role: Database["purama_ai"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      public_weekly_actions_count: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      start_trial: {
        Args: { p_plan_type: string }
        Returns: Database["purama_ai"]["Tables"]["subscriptions"]["Row"]
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      notification_type:
        | "task_completed"
        | "question"
        | "daily_report"
        | "alert"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  purama_ai: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      notification_type: [
        "task_completed",
        "question",
        "daily_report",
        "alert",
      ],
    },
  },
} as const
