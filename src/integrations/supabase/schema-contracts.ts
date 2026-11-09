// Generated from versioned SQL by scripts/generate-supabase-contracts.mjs.
// Rebuild: npm ci --prefix karta --ignore-scripts && node scripts/generate-supabase-contracts.mjs
// Check: node scripts/generate-supabase-contracts.mjs --check
// This is a local DDL contract, not an introspection or migration of the deployed database.
// Auth-schema foreign keys are omitted because auth is not an exposed client schema.
// p3_schema.sql sha256:c37d6608cc05748e5b4bb7ffe5490c5dadfaebe973befe3f9cf1106212cce4fc
// supabase/migrations/20260422180000_v4_1_stripe_connect_opentimestamps.sql sha256:586178ff7ceb246b06bfc6764ad1e43140e967f63548126616c6b51001a44ef0
import type { Json } from "./types"

export type P3Tables = {
  cross_promos: {
    Row: {
      id: string
      source_app: string
      target_app: string
      target_name: string
      target_description: string | null
      target_url: string
      target_color: string | null
      target_icon: string | null
      coupon_code: string | null
      is_active: boolean | null
      created_at: string | null
    }
    Insert: {
      id?: string
      source_app: string
      target_app: string
      target_name: string
      target_description?: string | null
      target_url: string
      target_color?: string | null
      target_icon?: string | null
      coupon_code?: string | null
      is_active?: boolean | null
      created_at?: string | null
    }
    Update: {
      id?: string
      source_app?: string
      target_app?: string
      target_name?: string
      target_description?: string | null
      target_url?: string
      target_color?: string | null
      target_icon?: string | null
      coupon_code?: string | null
      is_active?: boolean | null
      created_at?: string | null
    }
    Relationships: []
  }
  daily_gifts: {
    Row: {
      id: string
      user_id: string
      gift_type: string
      gift_value: string
      streak_count: number | null
      opened_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      gift_type: string
      gift_value: string
      streak_count?: number | null
      opened_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      gift_type?: string
      gift_value?: string
      streak_count?: number | null
      opened_at?: string | null
    }
    Relationships: []
  }
  faq_articles: {
    Row: {
      id: string
      category: string
      question: string
      answer: string
      search_keywords: string[] | null
      view_count: number | null
      helpful_count: number | null
      sort_order: number | null
      created_at: string | null
    }
    Insert: {
      id?: string
      category: string
      question: string
      answer: string
      search_keywords?: string[] | null
      view_count?: number | null
      helpful_count?: number | null
      sort_order?: number | null
      created_at?: string | null
    }
    Update: {
      id?: string
      category?: string
      question?: string
      answer?: string
      search_keywords?: string[] | null
      view_count?: number | null
      helpful_count?: number | null
      sort_order?: number | null
      created_at?: string | null
    }
    Relationships: []
  }
  lottery_draws: {
    Row: {
      id: string
      draw_date: string
      pool_amount: number | null
      status: string
      created_at: string | null
    }
    Insert: {
      id?: string
      draw_date: string
      pool_amount?: number | null
      status?: string
      created_at?: string | null
    }
    Update: {
      id?: string
      draw_date?: string
      pool_amount?: number | null
      status?: string
      created_at?: string | null
    }
    Relationships: []
  }
  lottery_tickets: {
    Row: {
      id: string
      user_id: string
      draw_id: string | null
      source: string
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      draw_id?: string | null
      source: string
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      draw_id?: string | null
      source?: string
      created_at?: string | null
    }
    Relationships: [
      {
        foreignKeyName: "lottery_tickets_draw_id_fkey"
        columns: ["draw_id"]
        isOneToOne: false
        referencedRelation: "lottery_draws"
        referencedColumns: ["id"]
      }
    ]
  }
  lottery_winners: {
    Row: {
      id: string
      draw_id: string
      user_id: string
      ticket_id: string | null
      rank: number
      amount_won: number
      created_at: string | null
    }
    Insert: {
      id?: string
      draw_id: string
      user_id: string
      ticket_id?: string | null
      rank: number
      amount_won: number
      created_at?: string | null
    }
    Update: {
      id?: string
      draw_id?: string
      user_id?: string
      ticket_id?: string | null
      rank?: number
      amount_won?: number
      created_at?: string | null
    }
    Relationships: [
      {
        foreignKeyName: "lottery_winners_draw_id_fkey"
        columns: ["draw_id"]
        isOneToOne: false
        referencedRelation: "lottery_draws"
        referencedColumns: ["id"]
      },
      {
        foreignKeyName: "lottery_winners_ticket_id_fkey"
        columns: ["ticket_id"]
        isOneToOne: false
        referencedRelation: "lottery_tickets"
        referencedColumns: ["id"]
      }
    ]
  }
  point_purchases: {
    Row: {
      id: string
      user_id: string
      item_id: string | null
      points_spent: number
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      item_id?: string | null
      points_spent: number
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      item_id?: string | null
      points_spent?: number
      created_at?: string | null
    }
    Relationships: [
      {
        foreignKeyName: "point_purchases_item_id_fkey"
        columns: ["item_id"]
        isOneToOne: false
        referencedRelation: "point_shop_items"
        referencedColumns: ["id"]
      }
    ]
  }
  point_shop_items: {
    Row: {
      id: string
      category: string
      name: string
      description: string | null
      cost_points: number
      type: string
      value: string | null
      is_active: boolean | null
      created_at: string | null
    }
    Insert: {
      id?: string
      category: string
      name: string
      description?: string | null
      cost_points: number
      type: string
      value?: string | null
      is_active?: boolean | null
      created_at?: string | null
    }
    Update: {
      id?: string
      category?: string
      name?: string
      description?: string | null
      cost_points?: number
      type?: string
      value?: string | null
      is_active?: boolean | null
      created_at?: string | null
    }
    Relationships: []
  }
  point_transactions: {
    Row: {
      id: string
      user_id: string
      amount: number
      type: string
      source: string
      description: string | null
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      amount: number
      type: string
      source: string
      description?: string | null
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      amount?: number
      type?: string
      source?: string
      description?: string | null
      created_at?: string | null
    }
    Relationships: []
  }
  purama_points: {
    Row: {
      id: string
      user_id: string
      balance: number | null
      lifetime_earned: number | null
      streak_days: number | null
      last_active_date: string | null
      streak_multiplier: number | null
      created_at: string | null
      updated_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      balance?: number | null
      lifetime_earned?: number | null
      streak_days?: number | null
      last_active_date?: string | null
      streak_multiplier?: number | null
      created_at?: string | null
      updated_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      balance?: number | null
      lifetime_earned?: number | null
      streak_days?: number | null
      last_active_date?: string | null
      streak_multiplier?: number | null
      created_at?: string | null
      updated_at?: string | null
    }
    Relationships: []
  }
  share_conversions: {
    Row: {
      id: string
      share_id: string
      new_user_id: string | null
      bonus_points_given: number | null
      converted_at: string | null
    }
    Insert: {
      id?: string
      share_id: string
      new_user_id?: string | null
      bonus_points_given?: number | null
      converted_at?: string | null
    }
    Update: {
      id?: string
      share_id?: string
      new_user_id?: string | null
      bonus_points_given?: number | null
      converted_at?: string | null
    }
    Relationships: [
      {
        foreignKeyName: "share_conversions_share_id_fkey"
        columns: ["share_id"]
        isOneToOne: false
        referencedRelation: "social_shares"
        referencedColumns: ["id"]
      }
    ]
  }
  social_shares: {
    Row: {
      id: string
      user_id: string
      share_code: string
      platform_hint: string | null
      points_given: number | null
      shared_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      share_code: string
      platform_hint?: string | null
      points_given?: number | null
      shared_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      share_code?: string
      platform_hint?: string | null
      points_given?: number | null
      shared_at?: string | null
    }
    Relationships: []
  }
  wallet_transactions: {
    Row: {
      id: string
      user_id: string
      amount: number
      type: string
      source: string
      description: string | null
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      amount: number
      type: string
      source: string
      description?: string | null
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      amount?: number
      type?: string
      source?: string
      description?: string | null
      created_at?: string | null
    }
    Relationships: []
  }
  wallets: {
    Row: {
      id: string
      user_id: string
      balance: number | null
      total_earned: number | null
      total_withdrawn: number | null
      created_at: string | null
      updated_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      balance?: number | null
      total_earned?: number | null
      total_withdrawn?: number | null
      created_at?: string | null
      updated_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      balance?: number | null
      total_earned?: number | null
      total_withdrawn?: number | null
      created_at?: string | null
      updated_at?: string | null
    }
    Relationships: []
  }
  withdrawals: {
    Row: {
      id: string
      user_id: string
      amount: number
      iban: string
      beneficiary_name: string
      status: string
      requested_at: string | null
      processed_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      amount: number
      iban: string
      beneficiary_name: string
      status?: string
      requested_at?: string | null
      processed_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      amount?: number
      iban?: string
      beneficiary_name?: string
      status?: string
      requested_at?: string | null
      processed_at?: string | null
    }
    Relationships: []
  }
}

export type PublicTables = {
  bourses_inclusion: {
    Row: {
      id: string
      user_id: string
      profil_social: string[] | null
      montant_eur: number | null
      missions_completees: number | null
      missions_requises: number | null
      versee: boolean | null
      versee_at: string | null
      financement_source: string | null
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      profil_social?: string[] | null
      montant_eur?: number | null
      missions_completees?: number | null
      missions_requises?: number | null
      versee?: boolean | null
      versee_at?: string | null
      financement_source?: string | null
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      profil_social?: string[] | null
      montant_eur?: number | null
      missions_completees?: number | null
      missions_requises?: number | null
      versee?: boolean | null
      versee_at?: string | null
      financement_source?: string | null
      created_at?: string | null
    }
    Relationships: []
  }
  connect_accounts: {
    Row: {
      user_id: string
      stripe_account_id: string
      onboarding_completed: boolean | null
      payouts_enabled: boolean | null
      charges_enabled: boolean | null
      kyc_verified_at: string | null
      requirements: Json | null
      country: string | null
      created_at: string | null
      updated_at: string | null
    }
    Insert: {
      user_id: string
      stripe_account_id: string
      onboarding_completed?: boolean | null
      payouts_enabled?: boolean | null
      charges_enabled?: boolean | null
      kyc_verified_at?: string | null
      requirements?: Json | null
      country?: string | null
      created_at?: string | null
      updated_at?: string | null
    }
    Update: {
      user_id?: string
      stripe_account_id?: string
      onboarding_completed?: boolean | null
      payouts_enabled?: boolean | null
      charges_enabled?: boolean | null
      kyc_verified_at?: string | null
      requirements?: Json | null
      country?: string | null
      created_at?: string | null
      updated_at?: string | null
    }
    Relationships: []
  }
  cpa_earnings: {
    Row: {
      id: string
      user_id: string
      app_id: string
      partner: string
      amount_eur: number
      received_at: string
      covers_prime_palier: number | null
      metadata: Json | null
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      app_id?: string
      partner: string
      amount_eur: number
      received_at: string
      covers_prime_palier?: number | null
      metadata?: Json | null
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      app_id?: string
      partner?: string
      amount_eur?: number
      received_at?: string
      covers_prime_palier?: number | null
      metadata?: Json | null
      created_at?: string | null
    }
    Relationships: []
  }
  primes: {
    Row: {
      id: string
      user_id: string
      app_id: string
      palier_actuel: number | null
      montant_verse_eur: number | null
      montant_total_eur: number | null
      prime_mode: string | null
      subscription_payment_check_1: boolean | null
      subscription_payment_check_2: boolean | null
      subscription_payment_check_3: boolean | null
      palier_1_date: string | null
      palier_2_date: string | null
      palier_3_date: string | null
      recuperee: boolean | null
      recuperee_at: string | null
      created_at: string | null
      updated_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      app_id?: string
      palier_actuel?: number | null
      montant_verse_eur?: number | null
      montant_total_eur?: number | null
      prime_mode?: string | null
      subscription_payment_check_1?: boolean | null
      subscription_payment_check_2?: boolean | null
      subscription_payment_check_3?: boolean | null
      palier_1_date?: string | null
      palier_2_date?: string | null
      palier_3_date?: string | null
      recuperee?: boolean | null
      recuperee_at?: string | null
      created_at?: string | null
      updated_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      app_id?: string
      palier_actuel?: number | null
      montant_verse_eur?: number | null
      montant_total_eur?: number | null
      prime_mode?: string | null
      subscription_payment_check_1?: boolean | null
      subscription_payment_check_2?: boolean | null
      subscription_payment_check_3?: boolean | null
      palier_1_date?: string | null
      palier_2_date?: string | null
      palier_3_date?: string | null
      recuperee?: boolean | null
      recuperee_at?: string | null
      created_at?: string | null
      updated_at?: string | null
    }
    Relationships: []
  }
  reglements: {
    Row: {
      id: string
      version: string
      type: string
      content_hash: string
      opentimestamps_proof: string | null
      blockchain: string | null
      published_at: string | null
      content_url: string | null
      content_markdown: string | null
      metadata: Json | null
    }
    Insert: {
      id?: string
      version: string
      type?: string
      content_hash: string
      opentimestamps_proof?: string | null
      blockchain?: string | null
      published_at?: string | null
      content_url?: string | null
      content_markdown?: string | null
      metadata?: Json | null
    }
    Update: {
      id?: string
      version?: string
      type?: string
      content_hash?: string
      opentimestamps_proof?: string | null
      blockchain?: string | null
      published_at?: string | null
      content_url?: string | null
      content_markdown?: string | null
      metadata?: Json | null
    }
    Relationships: []
  }
  user_tax_profiles: {
    Row: {
      user_id: string
      profile_type: string | null
      siret: string | null
      siren: string | null
      company_name: string | null
      legal_form: string | null
      activity_type: string | null
      tva_franchise: boolean | null
      urssaf_mandate_signed_at: string | null
      urssaf_mandate_doc_id: string | null
      pennylane_oauth_token_encrypted: string | null
      pennylane_company_id: string | null
      edi_tdfc_enabled: boolean | null
      threshold_305_alerted: boolean | null
      threshold_bnc_alerted: boolean | null
      threshold_tva_alerted: boolean | null
      onboarded_at: string | null
      updated_at: string | null
    }
    Insert: {
      user_id: string
      profile_type?: string | null
      siret?: string | null
      siren?: string | null
      company_name?: string | null
      legal_form?: string | null
      activity_type?: string | null
      tva_franchise?: boolean | null
      urssaf_mandate_signed_at?: string | null
      urssaf_mandate_doc_id?: string | null
      pennylane_oauth_token_encrypted?: string | null
      pennylane_company_id?: string | null
      edi_tdfc_enabled?: boolean | null
      threshold_305_alerted?: boolean | null
      threshold_bnc_alerted?: boolean | null
      threshold_tva_alerted?: boolean | null
      onboarded_at?: string | null
      updated_at?: string | null
    }
    Update: {
      user_id?: string
      profile_type?: string | null
      siret?: string | null
      siren?: string | null
      company_name?: string | null
      legal_form?: string | null
      activity_type?: string | null
      tva_franchise?: boolean | null
      urssaf_mandate_signed_at?: string | null
      urssaf_mandate_doc_id?: string | null
      pennylane_oauth_token_encrypted?: string | null
      pennylane_company_id?: string | null
      edi_tdfc_enabled?: boolean | null
      threshold_305_alerted?: boolean | null
      threshold_bnc_alerted?: boolean | null
      threshold_tva_alerted?: boolean | null
      onboarded_at?: string | null
      updated_at?: string | null
    }
    Relationships: []
  }
  wallet_transactions: {
    Row: {
      id: string
      user_id: string
      amount_eur: number
      direction: string
      source: string
      source_id: string | null
      stripe_transfer_id: string | null
      description: string | null
      metadata: Json | null
      created_at: string | null
    }
    Insert: {
      id?: string
      user_id: string
      amount_eur: number
      direction: string
      source: string
      source_id?: string | null
      stripe_transfer_id?: string | null
      description?: string | null
      metadata?: Json | null
      created_at?: string | null
    }
    Update: {
      id?: string
      user_id?: string
      amount_eur?: number
      direction?: string
      source?: string
      source_id?: string | null
      stripe_transfer_id?: string | null
      description?: string | null
      metadata?: Json | null
      created_at?: string | null
    }
    Relationships: []
  }
}
