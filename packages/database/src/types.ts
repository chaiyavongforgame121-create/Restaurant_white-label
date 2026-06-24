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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      abandoned_carts: {
        Row: {
          branch_id: string | null
          cart: Json
          created_at: string | null
          customer_email: string | null
          id: string
          notified_at: string | null
          recovered_order_id: string | null
          subtotal: number
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          branch_id?: string | null
          cart: Json
          created_at?: string | null
          customer_email?: string | null
          id?: string
          notified_at?: string | null
          recovered_order_id?: string | null
          subtotal?: number
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          branch_id?: string | null
          cart?: Json
          created_at?: string | null
          customer_email?: string | null
          id?: string
          notified_at?: string | null
          recovered_order_id?: string | null
          subtotal?: number
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "abandoned_carts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "abandoned_carts_recovered_order_id_fkey"
            columns: ["recovered_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          branch_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_address: unknown
          metadata: Json
          restaurant_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          branch_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: unknown
          metadata?: Json
          restaurant_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          branch_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: unknown
          metadata?: Json
          restaurant_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      birthday_rewards: {
        Row: {
          branch_id: string
          customer_id: string
          id: string
          issued_at: string | null
          points: number
          year: number
        }
        Insert: {
          branch_id: string
          customer_id: string
          id?: string
          issued_at?: string | null
          points: number
          year: number
        }
        Update: {
          branch_id?: string
          customer_id?: string
          id?: string
          issued_at?: string | null
          points?: number
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "birthday_rewards_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "birthday_rewards_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_closures: {
        Row: {
          branch_id: string
          created_at: string
          created_by: string | null
          ends_at: string
          id: string
          reason: string | null
          starts_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          created_by?: string | null
          ends_at: string
          id?: string
          reason?: string | null
          starts_at: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          created_by?: string | null
          ends_at?: string
          id?: string
          reason?: string | null
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_closures_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_hours: {
        Row: {
          branch_id: string
          closes_at: string
          day_of_week: number
          id: string
          opens_at: string
        }
        Insert: {
          branch_id: string
          closes_at: string
          day_of_week: number
          id?: string
          opens_at: string
        }
        Update: {
          branch_id?: string
          closes_at?: string
          day_of_week?: number
          id?: string
          opens_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_hours_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          brand_id: string | null
          created_at: string
          custom_domain: string | null
          geo_lat: number | null
          geo_lng: number | null
          geo_location: unknown
          id: string
          is_active: boolean
          name: string
          open_hours: Json
          restaurant_id: string
          sales_tax_rate: number
          settings: Json
          slug: string
          theme_override: Json
          timezone: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          brand_id?: string | null
          created_at?: string
          custom_domain?: string | null
          geo_lat?: number | null
          geo_lng?: number | null
          geo_location?: unknown
          id?: string
          is_active?: boolean
          name: string
          open_hours?: Json
          restaurant_id: string
          sales_tax_rate?: number
          settings?: Json
          slug: string
          theme_override?: Json
          timezone?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          brand_id?: string | null
          created_at?: string
          custom_domain?: string | null
          geo_lat?: number | null
          geo_lng?: number | null
          geo_location?: unknown
          id?: string
          is_active?: boolean
          name?: string
          open_hours?: Json
          restaurant_id?: string
          sales_tax_rate?: number
          settings?: Json
          slug?: string
          theme_override?: Json
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branches_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      brands: {
        Row: {
          created_at: string
          id: string
          is_default: boolean
          logo_url: string | null
          name: string
          restaurant_id: string
          slug: string
          theme: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_default?: boolean
          logo_url?: string | null
          name: string
          restaurant_id: string
          slug: string
          theme?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_default?: boolean
          logo_url?: string | null
          name?: string
          restaurant_id?: string
          slug?: string
          theme?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "brands_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcasts: {
        Row: {
          audience: Json
          body: string
          branch_id: string
          channels: string[]
          created_at: string
          created_by: string | null
          id: string
          recipient_count: number
          scheduled_for: string | null
          sent_at: string | null
          status: string
          title: string
          url: string | null
        }
        Insert: {
          audience?: Json
          body: string
          branch_id: string
          channels?: string[]
          created_at?: string
          created_by?: string | null
          id?: string
          recipient_count?: number
          scheduled_for?: string | null
          sent_at?: string | null
          status?: string
          title: string
          url?: string | null
        }
        Update: {
          audience?: Json
          body?: string
          branch_id?: string
          channels?: string[]
          created_at?: string
          created_by?: string | null
          id?: string
          recipient_count?: number
          scheduled_for?: string | null
          sent_at?: string | null
          status?: string
          title?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcasts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      cart_shares: {
        Row: {
          branch_id: string
          cart: Json
          created_at: string | null
          expires_at: string
          host_user_id: string | null
          id: string
          updated_at: string | null
        }
        Insert: {
          branch_id: string
          cart?: Json
          created_at?: string | null
          expires_at?: string
          host_user_id?: string | null
          id?: string
          updated_at?: string | null
        }
        Update: {
          branch_id?: string
          cart?: Json
          created_at?: string | null
          expires_at?: string
          host_user_id?: string | null
          id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cart_shares_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      combo_items: {
        Row: {
          combo_id: string
          is_swappable: boolean
          menu_item_id: string
          quantity: number
          swap_group: string | null
        }
        Insert: {
          combo_id: string
          is_swappable?: boolean
          menu_item_id: string
          quantity?: number
          swap_group?: string | null
        }
        Update: {
          combo_id?: string
          is_swappable?: boolean
          menu_item_id?: string
          quantity?: number
          swap_group?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "combo_items_combo_id_fkey"
            columns: ["combo_id"]
            isOneToOne: false
            referencedRelation: "combo_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "combo_items_combo_id_fkey"
            columns: ["combo_id"]
            isOneToOne: false
            referencedRelation: "v_active_combos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "combo_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "combo_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "v_low_stock_items"
            referencedColumns: ["id"]
          },
        ]
      }
      combo_sets: {
        Row: {
          branch_id: string
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean
          name: string
          total_price: number
        }
        Insert: {
          branch_id: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: string
          total_price: number
        }
        Update: {
          branch_id?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: string
          total_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "combo_sets_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_addresses: {
        Row: {
          address_line1: string
          address_line2: string | null
          city: string | null
          created_at: string
          customer_id: string
          delivery_notes: string | null
          district: string | null
          geo_location: unknown
          id: string
          is_default: boolean
          label: string | null
          lat: number | null
          lng: number | null
          postal_code: string | null
          province: string | null
          state: string | null
        }
        Insert: {
          address_line1: string
          address_line2?: string | null
          city?: string | null
          created_at?: string
          customer_id: string
          delivery_notes?: string | null
          district?: string | null
          geo_location?: unknown
          id?: string
          is_default?: boolean
          label?: string | null
          lat?: number | null
          lng?: number | null
          postal_code?: string | null
          province?: string | null
          state?: string | null
        }
        Update: {
          address_line1?: string
          address_line2?: string | null
          city?: string | null
          created_at?: string
          customer_id?: string
          delivery_notes?: string | null
          district?: string | null
          geo_location?: unknown
          id?: string
          is_default?: boolean
          label?: string | null
          lat?: number | null
          lng?: number | null
          postal_code?: string | null
          province?: string | null
          state?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          birthday: string | null
          branch_id: string
          created_at: string
          email: string | null
          full_name: string | null
          gender: string | null
          id: string
          last_order_at: string | null
          marketing_consent: boolean
          phone: string | null
          preferred_language: string
          restaurant_id: string
          total_orders: number
          total_spent: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          birthday?: string | null
          branch_id: string
          created_at?: string
          email?: string | null
          full_name?: string | null
          gender?: string | null
          id?: string
          last_order_at?: string | null
          marketing_consent?: boolean
          phone?: string | null
          preferred_language?: string
          restaurant_id: string
          total_orders?: number
          total_spent?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          birthday?: string | null
          branch_id?: string
          created_at?: string
          email?: string | null
          full_name?: string | null
          gender?: string | null
          id?: string
          last_order_at?: string | null
          marketing_consent?: boolean
          phone?: string | null
          preferred_language?: string
          restaurant_id?: string
          total_orders?: number
          total_spent?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries: {
        Row: {
          accepted_at: string | null
          arriving_at: string | null
          assigned_at: string | null
          branch_id: string
          created_at: string
          current_eta_min: number | null
          customer_rating: number | null
          customer_review: string | null
          delivered_at: string | null
          delivery_fee: number | null
          delivery_location: unknown
          dispatch_attempts: number
          dispatch_history: Json
          distance_km: number | null
          driver_earnings: number | null
          driver_id: string | null
          driver_lat: number | null
          driver_lng: number | null
          driver_location_updated_at: string | null
          dropoff_lat: number | null
          dropoff_lng: number | null
          estimated_duration_min: number | null
          failed_photo_url: string | null
          failed_reason: string | null
          id: string
          offer_expires_at: string | null
          offered_at: string | null
          order_id: string
          picked_up_at: string | null
          pickup_location: unknown
          pod_photo_url: string | null
          pod_uploaded_at: string | null
          status: Database["public"]["Enums"]["delivery_status"]
          surge_multiplier: number
        }
        Insert: {
          accepted_at?: string | null
          arriving_at?: string | null
          assigned_at?: string | null
          branch_id: string
          created_at?: string
          current_eta_min?: number | null
          customer_rating?: number | null
          customer_review?: string | null
          delivered_at?: string | null
          delivery_fee?: number | null
          delivery_location?: unknown
          dispatch_attempts?: number
          dispatch_history?: Json
          distance_km?: number | null
          driver_earnings?: number | null
          driver_id?: string | null
          driver_lat?: number | null
          driver_lng?: number | null
          driver_location_updated_at?: string | null
          dropoff_lat?: number | null
          dropoff_lng?: number | null
          estimated_duration_min?: number | null
          failed_photo_url?: string | null
          failed_reason?: string | null
          id?: string
          offer_expires_at?: string | null
          offered_at?: string | null
          order_id: string
          picked_up_at?: string | null
          pickup_location?: unknown
          pod_photo_url?: string | null
          pod_uploaded_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          surge_multiplier?: number
        }
        Update: {
          accepted_at?: string | null
          arriving_at?: string | null
          assigned_at?: string | null
          branch_id?: string
          created_at?: string
          current_eta_min?: number | null
          customer_rating?: number | null
          customer_review?: string | null
          delivered_at?: string | null
          delivery_fee?: number | null
          delivery_location?: unknown
          dispatch_attempts?: number
          dispatch_history?: Json
          distance_km?: number | null
          driver_earnings?: number | null
          driver_id?: string | null
          driver_lat?: number | null
          driver_lng?: number | null
          driver_location_updated_at?: string | null
          dropoff_lat?: number | null
          dropoff_lng?: number | null
          estimated_duration_min?: number | null
          failed_photo_url?: string | null
          failed_reason?: string | null
          id?: string
          offer_expires_at?: string | null
          offered_at?: string | null
          order_id?: string
          picked_up_at?: string | null
          pickup_location?: unknown
          pod_photo_url?: string | null
          pod_uploaded_at?: string | null
          status?: Database["public"]["Enums"]["delivery_status"]
          surge_multiplier?: number
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_messages: {
        Row: {
          body: string
          created_at: string
          delivery_id: string
          id: string
          read_at: string | null
          sender_role: string
          sender_user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          delivery_id: string
          id?: string
          read_at?: string | null
          sender_role: string
          sender_user_id?: string
        }
        Update: {
          body?: string
          created_at?: string
          delivery_id?: string
          id?: string
          read_at?: string | null
          sender_role?: string
          sender_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_approvals: {
        Row: {
          applied_at: string
          branch_id: string
          driver_id: string
          id: string
          notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["driver_approval_status"]
        }
        Insert: {
          applied_at?: string
          branch_id: string
          driver_id: string
          id?: string
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["driver_approval_status"]
        }
        Update: {
          applied_at?: string
          branch_id?: string
          driver_id?: string
          id?: string
          notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["driver_approval_status"]
        }
        Relationships: [
          {
            foreignKeyName: "driver_approvals_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_approvals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_approvals_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_schedules: {
        Row: {
          branch_id: string
          created_at: string
          driver_id: string
          end_at: string
          id: string
          notes: string | null
          start_at: string
          status: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          driver_id: string
          end_at: string
          id?: string
          notes?: string | null
          start_at: string
          status?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          driver_id?: string
          end_at?: string
          id?: string
          notes?: string | null
          start_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_schedules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_schedules_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_training: {
        Row: {
          completed_at: string | null
          completed_modules: Json
          driver_id: string
          quiz_passed: boolean | null
          quiz_score: number | null
          updated_at: string | null
        }
        Insert: {
          completed_at?: string | null
          completed_modules?: Json
          driver_id: string
          quiz_passed?: boolean | null
          quiz_score?: number | null
          updated_at?: string | null
        }
        Update: {
          completed_at?: string | null
          completed_modules?: Json
          driver_id?: string
          quiz_passed?: boolean | null
          quiz_score?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_training_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_withdrawals: {
        Row: {
          account_name: string
          account_number: string
          amount: number
          approved_at: string | null
          approved_by: string | null
          bank_name: string
          created_at: string
          driver_id: string
          id: string
          paid_at: string | null
          rejection_reason: string | null
          status: string
        }
        Insert: {
          account_name: string
          account_number: string
          amount: number
          approved_at?: string | null
          approved_by?: string | null
          bank_name: string
          created_at?: string
          driver_id: string
          id?: string
          paid_at?: string | null
          rejection_reason?: string | null
          status?: string
        }
        Update: {
          account_name?: string
          account_number?: string
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          bank_name?: string
          created_at?: string
          driver_id?: string
          id?: string
          paid_at?: string | null
          rejection_reason?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_withdrawals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          avatar_url: string | null
          average_rating: number | null
          bank_account_encrypted: string | null
          battery_level: number | null
          cancellation_count: number
          cooldown_until: string | null
          created_at: string
          current_location: unknown
          email: string | null
          full_name: string
          id: string
          is_online: boolean
          kyc_status: Database["public"]["Enums"]["driver_kyc_status"]
          kyc_verified_at: string | null
          location_updated_at: string | null
          national_id_encrypted: string | null
          national_id_hash: string | null
          phone: string
          reject_streak: number
          total_deliveries: number
          updated_at: string
          user_id: string | null
          vehicle_brand: string | null
          vehicle_plate: string | null
          vehicle_type: string
        }
        Insert: {
          avatar_url?: string | null
          average_rating?: number | null
          bank_account_encrypted?: string | null
          battery_level?: number | null
          cancellation_count?: number
          cooldown_until?: string | null
          created_at?: string
          current_location?: unknown
          email?: string | null
          full_name: string
          id?: string
          is_online?: boolean
          kyc_status?: Database["public"]["Enums"]["driver_kyc_status"]
          kyc_verified_at?: string | null
          location_updated_at?: string | null
          national_id_encrypted?: string | null
          national_id_hash?: string | null
          phone: string
          reject_streak?: number
          total_deliveries?: number
          updated_at?: string
          user_id?: string | null
          vehicle_brand?: string | null
          vehicle_plate?: string | null
          vehicle_type: string
        }
        Update: {
          avatar_url?: string | null
          average_rating?: number | null
          bank_account_encrypted?: string | null
          battery_level?: number | null
          cancellation_count?: number
          cooldown_until?: string | null
          created_at?: string
          current_location?: unknown
          email?: string | null
          full_name?: string
          id?: string
          is_online?: boolean
          kyc_status?: Database["public"]["Enums"]["driver_kyc_status"]
          kyc_verified_at?: string | null
          location_updated_at?: string | null
          national_id_encrypted?: string | null
          national_id_hash?: string | null
          phone?: string
          reject_streak?: number
          total_deliveries?: number
          updated_at?: string
          user_id?: string | null
          vehicle_brand?: string | null
          vehicle_plate?: string | null
          vehicle_type?: string
        }
        Relationships: []
      }
      food_safety_logs: {
        Row: {
          branch_id: string
          created_at: string | null
          id: string
          log_type: string
          logged_by: string | null
          notes: string | null
          pass: boolean | null
          reading: number | null
          station: string | null
          unit: string | null
        }
        Insert: {
          branch_id: string
          created_at?: string | null
          id?: string
          log_type: string
          logged_by?: string | null
          notes?: string | null
          pass?: boolean | null
          reading?: number | null
          station?: string | null
          unit?: string | null
        }
        Update: {
          branch_id?: string
          created_at?: string | null
          id?: string
          log_type?: string
          logged_by?: string | null
          notes?: string | null
          pass?: boolean | null
          reading?: number | null
          station?: string | null
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "food_safety_logs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      franchise_groups: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_user_id: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_user_id: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_user_id?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      franchise_menu_locks: {
        Row: {
          created_at: string
          group_id: string
          item_signature: string
          locked_fields: string[]
        }
        Insert: {
          created_at?: string
          group_id: string
          item_signature: string
          locked_fields?: string[]
        }
        Update: {
          created_at?: string
          group_id?: string
          item_signature?: string
          locked_fields?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "franchise_menu_locks_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "franchise_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      gift_card_redemptions: {
        Row: {
          amount: number
          created_at: string | null
          gift_card_id: string
          id: string
          order_id: string | null
          redeemed_by: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          gift_card_id: string
          id?: string
          order_id?: string | null
          redeemed_by?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          gift_card_id?: string
          id?: string
          order_id?: string | null
          redeemed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gift_card_redemptions_gift_card_id_fkey"
            columns: ["gift_card_id"]
            isOneToOne: false
            referencedRelation: "gift_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_card_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      gift_cards: {
        Row: {
          balance: number
          branch_id: string | null
          code: string
          created_at: string | null
          currency: string
          expires_at: string | null
          id: string
          initial_amount: number
          message: string | null
          purchased_by: string | null
          recipient_email: string | null
          recipient_name: string | null
          restaurant_id: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          balance: number
          branch_id?: string | null
          code: string
          created_at?: string | null
          currency?: string
          expires_at?: string | null
          id?: string
          initial_amount: number
          message?: string | null
          purchased_by?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
          restaurant_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          balance?: number
          branch_id?: string | null
          code?: string
          created_at?: string | null
          currency?: string
          expires_at?: string | null
          id?: string
          initial_amount?: number
          message?: string | null
          purchased_by?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
          restaurant_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gift_cards_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_cards_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      happy_hours: {
        Row: {
          applies_to_category_ids: string[]
          applies_to_item_ids: string[]
          branch_id: string
          created_at: string | null
          days_of_week: number[]
          discount_type: string
          discount_value: number
          display_order: number
          end_time: string
          id: string
          is_active: boolean
          name: string
          start_time: string
        }
        Insert: {
          applies_to_category_ids?: string[]
          applies_to_item_ids?: string[]
          branch_id: string
          created_at?: string | null
          days_of_week?: number[]
          discount_type: string
          discount_value: number
          display_order?: number
          end_time: string
          id?: string
          is_active?: boolean
          name: string
          start_time: string
        }
        Update: {
          applies_to_category_ids?: string[]
          applies_to_item_ids?: string[]
          branch_id?: string
          created_at?: string | null
          days_of_week?: number[]
          discount_type?: string
          discount_value?: number
          display_order?: number
          end_time?: string
          id?: string
          is_active?: boolean
          name?: string
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "happy_hours_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          branch_id: string
          config: Json
          created_at: string | null
          id: string
          is_active: boolean
          last_error: string | null
          last_synced_at: string | null
          provider: string
          updated_at: string | null
        }
        Insert: {
          branch_id: string
          config?: Json
          created_at?: string | null
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          provider: string
          updated_at?: string | null
        }
        Update: {
          branch_id?: string
          config?: Json
          created_at?: string | null
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          provider?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "integrations_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount: number
          created_at: string
          due_date: string
          id: string
          invoice_number: string
          line_items: Json
          paid_at: string | null
          pdf_url: string | null
          restaurant_id: string
          status: string
          subscription_id: string
          tax: number
          total: number
        }
        Insert: {
          amount: number
          created_at?: string
          due_date: string
          id?: string
          invoice_number: string
          line_items: Json
          paid_at?: string | null
          pdf_url?: string | null
          restaurant_id: string
          status: string
          subscription_id: string
          tax?: number
          total: number
        }
        Update: {
          amount?: number
          created_at?: string
          due_date?: string
          id?: string
          invoice_number?: string
          line_items?: Json
          paid_at?: string | null
          pdf_url?: string | null
          restaurant_id?: string
          status?: string
          subscription_id?: string
          tax?: number
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_points: {
        Row: {
          branch_id: string | null
          customer_id: string
          id: string
          lifetime_earned: number
          lifetime_spent: number
          points_balance: number
          restaurant_id: string | null
          tier: Database["public"]["Enums"]["loyalty_tier"]
          tier_expires_at: string | null
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          customer_id: string
          id?: string
          lifetime_earned?: number
          lifetime_spent?: number
          points_balance?: number
          restaurant_id?: string | null
          tier?: Database["public"]["Enums"]["loyalty_tier"]
          tier_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          customer_id?: string
          id?: string
          lifetime_earned?: number
          lifetime_spent?: number
          points_balance?: number
          restaurant_id?: string | null
          tier?: Database["public"]["Enums"]["loyalty_tier"]
          tier_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_points_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_points_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_points_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      loyalty_transactions: {
        Row: {
          balance_after: number
          branch_id: string | null
          created_at: string
          customer_id: string
          description: string | null
          expires_at: string | null
          id: string
          points: number
          reference_id: string | null
          reference_type: string | null
          restaurant_id: string | null
          type: string
        }
        Insert: {
          balance_after: number
          branch_id?: string | null
          created_at?: string
          customer_id: string
          description?: string | null
          expires_at?: string | null
          id?: string
          points: number
          reference_id?: string | null
          reference_type?: string | null
          restaurant_id?: string | null
          type: string
        }
        Update: {
          balance_after?: number
          branch_id?: string | null
          created_at?: string
          customer_id?: string
          description?: string | null
          expires_at?: string | null
          id?: string
          points?: number
          reference_id?: string | null
          reference_type?: string | null
          restaurant_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_transactions_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loyalty_transactions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_categories: {
        Row: {
          available_hours: Json | null
          branch_id: string
          created_at: string
          description: string | null
          display_order: number
          icon_emoji: string | null
          id: string
          is_active: boolean
          name: string
          name_translations: Json
          updated_at: string
        }
        Insert: {
          available_hours?: Json | null
          branch_id: string
          created_at?: string
          description?: string | null
          display_order?: number
          icon_emoji?: string | null
          id?: string
          is_active?: boolean
          name: string
          name_translations?: Json
          updated_at?: string
        }
        Update: {
          available_hours?: Json | null
          branch_id?: string
          created_at?: string
          description?: string | null
          display_order?: number
          icon_emoji?: string | null
          id?: string
          is_active?: boolean
          name?: string
          name_translations?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_categories_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_item_modifiers: {
        Row: {
          display_order: number
          menu_item_id: string
          modifier_group_id: string
        }
        Insert: {
          display_order?: number
          menu_item_id: string
          modifier_group_id: string
        }
        Update: {
          display_order?: number
          menu_item_id?: string
          modifier_group_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_item_modifiers_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_modifiers_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "v_low_stock_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_item_modifiers_modifier_group_id_fkey"
            columns: ["modifier_group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      menu_items: {
        Row: {
          allergens: string[]
          availability_schedule: Json
          available_channels: string[]
          branch_id: string
          calories: number | null
          category_id: string | null
          cost: number | null
          created_at: string
          description: string | null
          description_translations: Json
          dietary_tags: string[]
          display_order: number
          id: string
          image_url: string | null
          image_urls: Json
          is_active: boolean
          is_new: boolean
          is_recommended: boolean
          layout_config: Json | null
          low_stock_threshold: number
          name: string
          name_translations: Json
          prep_time_minutes: number | null
          price: number
          rating: number | null
          requires_age_verification: boolean
          review_count: number
          slug: string | null
          station: string | null
          stock_quantity: number | null
          track_stock: boolean
          updated_at: string
        }
        Insert: {
          allergens?: string[]
          availability_schedule?: Json
          available_channels?: string[]
          branch_id: string
          calories?: number | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          description?: string | null
          description_translations?: Json
          dietary_tags?: string[]
          display_order?: number
          id?: string
          image_url?: string | null
          image_urls?: Json
          is_active?: boolean
          is_new?: boolean
          is_recommended?: boolean
          layout_config?: Json | null
          low_stock_threshold?: number
          name: string
          name_translations?: Json
          prep_time_minutes?: number | null
          price: number
          rating?: number | null
          requires_age_verification?: boolean
          review_count?: number
          slug?: string | null
          station?: string | null
          stock_quantity?: number | null
          track_stock?: boolean
          updated_at?: string
        }
        Update: {
          allergens?: string[]
          availability_schedule?: Json
          available_channels?: string[]
          branch_id?: string
          calories?: number | null
          category_id?: string | null
          cost?: number | null
          created_at?: string
          description?: string | null
          description_translations?: Json
          dietary_tags?: string[]
          display_order?: number
          id?: string
          image_url?: string | null
          image_urls?: Json
          is_active?: boolean
          is_new?: boolean
          is_recommended?: boolean
          layout_config?: Json | null
          low_stock_threshold?: number
          name?: string
          name_translations?: Json
          prep_time_minutes?: number | null
          price?: number
          rating?: number | null
          requires_age_verification?: boolean
          review_count?: number
          slug?: string | null
          station?: string | null
          stock_quantity?: number | null
          track_stock?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "menu_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "menu_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      modifier_groups: {
        Row: {
          branch_id: string
          created_at: string
          display_order: number
          id: string
          is_required: boolean
          max_select: number | null
          min_select: number
          name: string
          name_translations: Json
          selection_type: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          display_order?: number
          id?: string
          is_required?: boolean
          max_select?: number | null
          min_select?: number
          name: string
          name_translations?: Json
          selection_type: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          display_order?: number
          id?: string
          is_required?: boolean
          max_select?: number | null
          min_select?: number
          name?: string
          name_translations?: Json
          selection_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "modifier_groups_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      modifier_options: {
        Row: {
          created_at: string
          display_order: number
          group_id: string
          id: string
          is_active: boolean
          is_default: boolean
          name: string
          name_translations: Json
          price_delta: number
        }
        Insert: {
          created_at?: string
          display_order?: number
          group_id: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
          name_translations?: Json
          price_delta?: number
        }
        Update: {
          created_at?: string
          display_order?: number
          group_id?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
          name_translations?: Json
          price_delta?: number
        }
        Relationships: [
          {
            foreignKeyName: "modifier_options_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "modifier_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications_outbox: {
        Row: {
          attempts: number
          branch_id: string | null
          channel: string
          created_at: string
          id: string
          last_error: string | null
          recipient_id: string
          recipient_type: string
          scheduled_for: string
          sent_at: string | null
          status: string
          template: string
          variables: Json
        }
        Insert: {
          attempts?: number
          branch_id?: string | null
          channel: string
          created_at?: string
          id?: string
          last_error?: string | null
          recipient_id: string
          recipient_type: string
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          template: string
          variables?: Json
        }
        Update: {
          attempts?: number
          branch_id?: string | null
          channel?: string
          created_at?: string
          id?: string
          last_error?: string | null
          recipient_id?: string
          recipient_type?: string
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          template?: string
          variables?: Json
        }
        Relationships: [
          {
            foreignKeyName: "notifications_outbox_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          combo_id: string | null
          created_at: string
          id: string
          item_image_url: string | null
          item_name: string
          menu_item_id: string | null
          modifier_total: number
          modifiers: Json
          notes: string | null
          order_id: string
          prep_status: string
          quantity: number
          station: string | null
          subtotal: number
          unit_price: number
        }
        Insert: {
          combo_id?: string | null
          created_at?: string
          id?: string
          item_image_url?: string | null
          item_name: string
          menu_item_id?: string | null
          modifier_total?: number
          modifiers?: Json
          notes?: string | null
          order_id: string
          prep_status?: string
          quantity: number
          station?: string | null
          subtotal: number
          unit_price: number
        }
        Update: {
          combo_id?: string | null
          created_at?: string
          id?: string
          item_image_url?: string | null
          item_name?: string
          menu_item_id?: string | null
          modifier_total?: number
          modifiers?: Json
          notes?: string | null
          order_id?: string
          prep_status?: string
          quantity?: number
          station?: string | null
          subtotal?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_combo_id_fkey"
            columns: ["combo_id"]
            isOneToOne: false
            referencedRelation: "combo_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_combo_id_fkey"
            columns: ["combo_id"]
            isOneToOne: false
            referencedRelation: "v_active_combos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "v_low_stock_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_ratings: {
        Row: {
          branch_id: string
          comment: string | null
          created_at: string
          customer_id: string
          delivery_stars: number | null
          driver_id: string | null
          food_stars: number | null
          id: string
          order_id: string
        }
        Insert: {
          branch_id: string
          comment?: string | null
          created_at?: string
          customer_id: string
          delivery_stars?: number | null
          driver_id?: string | null
          food_stars?: number | null
          id?: string
          order_id: string
        }
        Update: {
          branch_id?: string
          comment?: string | null
          created_at?: string
          customer_id?: string
          delivery_stars?: number | null
          driver_id?: string | null
          food_stars?: number | null
          id?: string
          order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_ratings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_ratings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_ratings_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          branch_id: string
          channel: Database["public"]["Enums"]["order_channel"]
          completed_at: string | null
          confirmed_at: string | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          customer_notes: string | null
          customer_phone: string | null
          delivery_address: Json | null
          delivery_fee: number
          device_id: string | null
          discount_amount: number
          held: boolean
          id: string
          kitchen_notes: string | null
          order_number: string
          promo_code: string | null
          promo_discount: number
          schedule_window_minutes: number | null
          scheduled_for: string | null
          service_fee: number
          source: string
          staff_id: string | null
          status: Database["public"]["Enums"]["order_status"]
          status_history: Json
          subtotal: number
          table_id: string | null
          tax_amount: number
          tip_amount: number
          total: number
        }
        Insert: {
          branch_id: string
          channel: Database["public"]["Enums"]["order_channel"]
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          customer_notes?: string | null
          customer_phone?: string | null
          delivery_address?: Json | null
          delivery_fee?: number
          device_id?: string | null
          discount_amount?: number
          held?: boolean
          id?: string
          kitchen_notes?: string | null
          order_number: string
          promo_code?: string | null
          promo_discount?: number
          schedule_window_minutes?: number | null
          scheduled_for?: string | null
          service_fee?: number
          source?: string
          staff_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          status_history?: Json
          subtotal: number
          table_id?: string | null
          tax_amount?: number
          tip_amount?: number
          total: number
        }
        Update: {
          branch_id?: string
          channel?: Database["public"]["Enums"]["order_channel"]
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          customer_notes?: string | null
          customer_phone?: string | null
          delivery_address?: Json | null
          delivery_fee?: number
          device_id?: string | null
          discount_amount?: number
          held?: boolean
          id?: string
          kitchen_notes?: string | null
          order_number?: string
          promo_code?: string | null
          promo_discount?: number
          schedule_window_minutes?: number | null
          scheduled_for?: string | null
          service_fee?: number
          source?: string
          staff_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          status_history?: Json
          subtotal?: number
          table_id?: string | null
          tax_amount?: number
          tip_amount?: number
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_orders_customer"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "v_branch_floor_plan"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          branch_id: string
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          gateway: string | null
          gateway_charge_id: string | null
          gateway_metadata: Json
          id: string
          method: string
          order_id: string
          paid_at: string | null
          proof_image_url: string | null
          status: Database["public"]["Enums"]["payment_status"]
        }
        Insert: {
          amount: number
          branch_id: string
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          gateway?: string | null
          gateway_charge_id?: string | null
          gateway_metadata?: Json
          id?: string
          method: string
          order_id: string
          paid_at?: string | null
          proof_image_url?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
        }
        Update: {
          amount?: number
          branch_id?: string
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          gateway?: string | null
          gateway_charge_id?: string | null
          gateway_metadata?: Json
          id?: string
          method?: string
          order_id?: string
          paid_at?: string | null
          proof_image_url?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "payments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      peak_hour_bonuses: {
        Row: {
          branch_id: string
          created_at: string | null
          days_of_week: number[]
          end_time: string
          id: string
          is_active: boolean
          multiplier: number
          name: string
          start_time: string
        }
        Insert: {
          branch_id: string
          created_at?: string | null
          days_of_week?: number[]
          end_time: string
          id?: string
          is_active?: boolean
          multiplier?: number
          name: string
          start_time: string
        }
        Update: {
          branch_id?: string
          created_at?: string | null
          days_of_week?: number[]
          end_time?: string
          id?: string
          is_active?: boolean
          multiplier?: number
          name?: string
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "peak_hour_bonuses_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      promo_redemptions: {
        Row: {
          amount_off: number
          customer_id: string
          id: string
          order_id: string | null
          promo_id: string
          redeemed_at: string
        }
        Insert: {
          amount_off: number
          customer_id: string
          id?: string
          order_id?: string | null
          promo_id: string
          redeemed_at?: string
        }
        Update: {
          amount_off?: number
          customer_id?: string
          id?: string
          order_id?: string | null
          promo_id?: string
          redeemed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promo_redemptions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promo_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "promo_redemptions_promo_id_fkey"
            columns: ["promo_id"]
            isOneToOne: false
            referencedRelation: "promos"
            referencedColumns: ["id"]
          },
        ]
      }
      promos: {
        Row: {
          branch_id: string
          code: string
          created_at: string
          ends_at: string | null
          id: string
          is_active: boolean
          kind: string
          max_redemptions: number | null
          min_subtotal: number
          per_customer_limit: number
          redemption_count: number
          starts_at: string
          value: number
        }
        Insert: {
          branch_id: string
          code: string
          created_at?: string
          ends_at?: string | null
          id?: string
          is_active?: boolean
          kind: string
          max_redemptions?: number | null
          min_subtotal?: number
          per_customer_limit?: number
          redemption_count?: number
          starts_at?: string
          value?: number
        }
        Update: {
          branch_id?: string
          code?: string
          created_at?: string
          ends_at?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          max_redemptions?: number | null
          min_subtotal?: number
          per_customer_limit?: number
          redemption_count?: number
          starts_at?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "promos_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          recipient_id: string
          recipient_type: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          recipient_id: string
          recipient_type: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          recipient_id?: string
          recipient_type?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          bucket_key: string
          count: number
          window_start: string
        }
        Insert: {
          bucket_key: string
          count?: number
          window_start: string
        }
        Update: {
          bucket_key?: string
          count?: number
          window_start?: string
        }
        Relationships: []
      }
      recurring_orders: {
        Row: {
          branch_id: string
          cadence: string
          cart: Json
          created_at: string | null
          customer_id: string
          day_of_week: number | null
          hour_of_day: number
          id: string
          is_active: boolean
          last_run_at: string | null
          next_run_at: string
        }
        Insert: {
          branch_id: string
          cadence: string
          cart: Json
          created_at?: string | null
          customer_id: string
          day_of_week?: number | null
          hour_of_day?: number
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          next_run_at: string
        }
        Update: {
          branch_id?: string
          cadence?: string
          cart?: Json
          created_at?: string | null
          customer_id?: string
          day_of_week?: number | null
          hour_of_day?: number
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          next_run_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_orders_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_codes: {
        Row: {
          code: string
          created_at: string | null
          reward_points: number
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string | null
          reward_points?: number
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string | null
          reward_points?: number
          user_id?: string
        }
        Relationships: []
      }
      referral_redemptions: {
        Row: {
          created_at: string | null
          id: string
          order_id: string | null
          referred_customer_id: string
          referrer_user_id: string
          reward_points: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          order_id?: string | null
          referred_customer_id: string
          referrer_user_id: string
          reward_points: number
        }
        Update: {
          created_at?: string | null
          id?: string
          order_id?: string | null
          referred_customer_id?: string
          referrer_user_id?: string
          reward_points?: number
        }
        Relationships: [
          {
            foreignKeyName: "referral_redemptions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_redemptions_referred_customer_id_fkey"
            columns: ["referred_customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      reservations: {
        Row: {
          branch_id: string
          created_at: string
          customer_id: string | null
          customer_name: string
          customer_phone: string
          duration_minutes: number
          id: string
          notes: string | null
          party_size: number
          reserved_for: string
          source: string
          status: string
          table_id: string | null
          updated_at: string
        }
        Insert: {
          branch_id: string
          created_at?: string
          customer_id?: string | null
          customer_name: string
          customer_phone: string
          duration_minutes?: number
          id?: string
          notes?: string | null
          party_size: number
          reserved_for: string
          source?: string
          status?: string
          table_id?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          customer_phone?: string
          duration_minutes?: number
          id?: string
          notes?: string | null
          party_size?: number
          reserved_for?: string
          source?: string
          status?: string
          table_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservations_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "tables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "v_branch_floor_plan"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurants: {
        Row: {
          brand_settings: Json
          created_at: string
          custom_domain: string | null
          franchise_group_id: string | null
          id: string
          loyalty_scope: string
          name: string
          owner_user_id: string
          slug: string
          updated_at: string
        }
        Insert: {
          brand_settings?: Json
          created_at?: string
          custom_domain?: string | null
          franchise_group_id?: string | null
          id?: string
          loyalty_scope?: string
          name: string
          owner_user_id: string
          slug: string
          updated_at?: string
        }
        Update: {
          brand_settings?: Json
          created_at?: string
          custom_domain?: string | null
          franchise_group_id?: string | null
          id?: string
          loyalty_scope?: string
          name?: string
          owner_user_id?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurants_franchise_group_id_fkey"
            columns: ["franchise_group_id"]
            isOneToOne: false
            referencedRelation: "franchise_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      restock_log: {
        Row: {
          branch_id: string
          cost_per_unit: number | null
          created_at: string | null
          created_by: string | null
          delta: number
          id: string
          menu_item_id: string
          notes: string | null
          supplier: string | null
        }
        Insert: {
          branch_id: string
          cost_per_unit?: number | null
          created_at?: string | null
          created_by?: string | null
          delta: number
          id?: string
          menu_item_id: string
          notes?: string | null
          supplier?: string | null
        }
        Update: {
          branch_id?: string
          cost_per_unit?: number | null
          created_at?: string | null
          created_by?: string | null
          delta?: number
          id?: string
          menu_item_id?: string
          notes?: string | null
          supplier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "restock_log_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restock_log_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "restock_log_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "v_low_stock_items"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_members: {
        Row: {
          accepted_at: string | null
          branch_id: string | null
          created_at: string
          id: string
          invited_at: string
          invited_email: string | null
          permissions: string[]
          pin_hash: string | null
          restaurant_id: string
          role: Database["public"]["Enums"]["staff_role"]
          status: Database["public"]["Enums"]["staff_status"]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          branch_id?: string | null
          created_at?: string
          id?: string
          invited_at?: string
          invited_email?: string | null
          permissions?: string[]
          pin_hash?: string | null
          restaurant_id: string
          role: Database["public"]["Enums"]["staff_role"]
          status?: Database["public"]["Enums"]["staff_status"]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          branch_id?: string | null
          created_at?: string
          id?: string
          invited_at?: string
          invited_email?: string | null
          permissions?: string[]
          pin_hash?: string | null
          restaurant_id?: string
          role?: Database["public"]["Enums"]["staff_role"]
          status?: Database["public"]["Enums"]["staff_status"]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_members_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_members_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_shifts: {
        Row: {
          branch_id: string
          clocked_in_at: string
          clocked_out_at: string | null
          created_at: string | null
          id: string
          notes: string | null
          shift_role: string | null
          staff_member_id: string
        }
        Insert: {
          branch_id: string
          clocked_in_at?: string
          clocked_out_at?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          shift_role?: string | null
          staff_member_id: string
        }
        Update: {
          branch_id?: string
          clocked_in_at?: string
          clocked_out_at?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          shift_role?: string | null
          staff_member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_shifts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_shifts_staff_member_id_fkey"
            columns: ["staff_member_id"]
            isOneToOne: false
            referencedRelation: "staff_members"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          limits: Json
          monthly_price: number
          name: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          limits?: Json
          monthly_price: number
          name: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          limits?: Json
          monthly_price?: number
          name?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          billing_cycle: string
          branch_count: number
          cancel_at_period_end: boolean
          cancelled_at: string | null
          created_at: string
          current_period_end: string
          current_period_start: string
          id: string
          next_billing_at: string | null
          payment_method_id: string | null
          plan_code: string | null
          restaurant_id: string
          status: Database["public"]["Enums"]["subscription_status"]
          tier: Database["public"]["Enums"]["subscription_tier"]
          trial_ends_at: string | null
          unit_price: number
          updated_at: string
        }
        Insert: {
          billing_cycle?: string
          branch_count?: number
          cancel_at_period_end?: boolean
          cancelled_at?: string | null
          created_at?: string
          current_period_end: string
          current_period_start: string
          id?: string
          next_billing_at?: string | null
          payment_method_id?: string | null
          plan_code?: string | null
          restaurant_id: string
          status?: Database["public"]["Enums"]["subscription_status"]
          tier?: Database["public"]["Enums"]["subscription_tier"]
          trial_ends_at?: string | null
          unit_price: number
          updated_at?: string
        }
        Update: {
          billing_cycle?: string
          branch_count?: number
          cancel_at_period_end?: boolean
          cancelled_at?: string | null
          created_at?: string
          current_period_end?: string
          current_period_start?: string
          id?: string
          next_billing_at?: string | null
          payment_method_id?: string | null
          plan_code?: string | null
          restaurant_id?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          tier?: Database["public"]["Enums"]["subscription_tier"]
          trial_ends_at?: string | null
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_code_fkey"
            columns: ["plan_code"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "subscriptions_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          branch_id: string
          category: string
          created_at: string | null
          customer_id: string | null
          id: string
          message: string
          order_id: string | null
          photo_url: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          branch_id: string
          category: string
          created_at?: string | null
          customer_id?: string | null
          id?: string
          message: string
          order_id?: string | null
          photo_url?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          branch_id?: string
          category?: string
          created_at?: string | null
          customer_id?: string | null
          id?: string
          message?: string
          order_id?: string | null
          photo_url?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          attempts: number
          created_at: string | null
          finished_at: string | null
          id: string
          integration_id: string
          kind: string
          last_error: string | null
          payload: Json | null
          result: Json | null
          scheduled_for: string | null
          started_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string | null
          finished_at?: string | null
          id?: string
          integration_id: string
          kind: string
          last_error?: string | null
          payload?: Json | null
          result?: Json | null
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string | null
          finished_at?: string | null
          id?: string
          integration_id?: string
          kind?: string
          last_error?: string | null
          payload?: Json | null
          result?: Json | null
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_jobs_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      tables: {
        Row: {
          branch_id: string
          capacity: number | null
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          pos_h: number | null
          pos_w: number | null
          pos_x: number | null
          pos_y: number | null
          qr_code_token: string | null
          shape: string | null
          status: string | null
          table_number: string
          zone: string | null
        }
        Insert: {
          branch_id: string
          capacity?: number | null
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          pos_h?: number | null
          pos_w?: number | null
          pos_x?: number | null
          pos_y?: number | null
          qr_code_token?: string | null
          shape?: string | null
          status?: string | null
          table_number: string
          zone?: string | null
        }
        Update: {
          branch_id?: string
          capacity?: number | null
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          pos_h?: number | null
          pos_w?: number | null
          pos_x?: number | null
          pos_y?: number | null
          qr_code_token?: string | null
          shape?: string | null
          status?: string | null
          table_number?: string
          zone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tables_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_invoice_sequence: {
        Row: {
          branch_id: string
          next_value: number
          prefix: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          next_value?: number
          prefix?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          next_value?: number
          prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_invoice_sequence_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: true
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_invoices: {
        Row: {
          branch_id: string
          buyer_address: string | null
          buyer_email: string | null
          buyer_name: string
          buyer_tax_id: string | null
          canceled_at: string | null
          created_at: string
          created_by: string | null
          id: string
          invoice_number: string
          invoice_type: string
          issued_at: string | null
          line_items: Json
          order_id: string
          pdf_url: string | null
          rd_response: Json | null
          rd_submitted_at: string | null
          status: string
          subtotal: number
          total: number
          updated_at: string
          vat_amount: number
          xml_payload: string | null
        }
        Insert: {
          branch_id: string
          buyer_address?: string | null
          buyer_email?: string | null
          buyer_name: string
          buyer_tax_id?: string | null
          canceled_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_number: string
          invoice_type?: string
          issued_at?: string | null
          line_items?: Json
          order_id: string
          pdf_url?: string | null
          rd_response?: Json | null
          rd_submitted_at?: string | null
          status?: string
          subtotal: number
          total: number
          updated_at?: string
          vat_amount?: number
          xml_payload?: string | null
        }
        Update: {
          branch_id?: string
          buyer_address?: string | null
          buyer_email?: string | null
          buyer_name?: string
          buyer_tax_id?: string | null
          canceled_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_number?: string
          invoice_type?: string
          issued_at?: string | null
          line_items?: Json
          order_id?: string
          pdf_url?: string | null
          rd_response?: Json | null
          rd_submitted_at?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
          vat_amount?: number
          xml_payload?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_invoices_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_invoices_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          added_at: string | null
          added_by: string | null
          branch_id: string
          id: string
          notes: string | null
          notified_at: string | null
          party_name: string
          party_size: number
          phone: string | null
          position: number | null
          seated_at: string | null
          status: string
        }
        Insert: {
          added_at?: string | null
          added_by?: string | null
          branch_id: string
          id?: string
          notes?: string | null
          notified_at?: string | null
          party_name: string
          party_size: number
          phone?: string | null
          position?: number | null
          seated_at?: string | null
          status?: string
        }
        Update: {
          added_at?: string | null
          added_by?: string | null
          branch_id?: string
          id?: string
          notes?: string | null
          notified_at?: string | null
          party_name?: string
          party_size?: number
          phone?: string | null
          position?: number | null
          seated_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "waitlist_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      waste_log: {
        Row: {
          branch_id: string
          created_at: string | null
          created_by: string | null
          id: string
          menu_item_id: string
          notes: string | null
          quantity: number
          reason: string
        }
        Insert: {
          branch_id: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          menu_item_id: string
          notes?: string | null
          quantity: number
          reason: string
        }
        Update: {
          branch_id?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          menu_item_id?: string
          notes?: string | null
          quantity?: number
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "waste_log_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waste_log_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waste_log_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "v_low_stock_items"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_active_combos: {
        Row: {
          branch_id: string | null
          description: string | null
          id: string | null
          image_url: string | null
          is_active: boolean | null
          items: Json | null
          name: string | null
          total_price: number | null
        }
        Relationships: [
          {
            foreignKeyName: "combo_sets_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      v_branch_floor_plan: {
        Row: {
          branch_id: string | null
          capacity: number | null
          display_name: string | null
          id: string | null
          is_active: boolean | null
          open_orders: number | null
          pos_h: number | null
          pos_w: number | null
          pos_x: number | null
          pos_y: number | null
          shape: string | null
          status: string | null
          table_number: string | null
          zone: string | null
        }
        Insert: {
          branch_id?: string | null
          capacity?: number | null
          display_name?: string | null
          id?: string | null
          is_active?: boolean | null
          open_orders?: never
          pos_h?: number | null
          pos_w?: number | null
          pos_x?: number | null
          pos_y?: number | null
          shape?: string | null
          status?: string | null
          table_number?: string | null
          zone?: string | null
        }
        Update: {
          branch_id?: string | null
          capacity?: number | null
          display_name?: string | null
          id?: string | null
          is_active?: boolean | null
          open_orders?: never
          pos_h?: number | null
          pos_w?: number | null
          pos_x?: number | null
          pos_y?: number | null
          shape?: string | null
          status?: string | null
          table_number?: string | null
          zone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tables_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
      v_low_stock_items: {
        Row: {
          branch_id: string | null
          id: string | null
          image_url: string | null
          low_stock_threshold: number | null
          name: string | null
          price: number | null
          stock_quantity: number | null
        }
        Insert: {
          branch_id?: string | null
          id?: string | null
          image_url?: string | null
          low_stock_threshold?: number | null
          name?: string | null
          price?: number | null
          stock_quantity?: number | null
        }
        Update: {
          branch_id?: string | null
          id?: string | null
          image_url?: string | null
          low_stock_threshold?: number | null
          name?: string | null
          price?: number | null
          stock_quantity?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "menu_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_dispatch: { Args: { p_delivery_id: string }; Returns: undefined }
      admin_edit_order_notes: {
        Args: { p_notes: string; p_order_id: string }
        Returns: {
          branch_id: string
          channel: Database["public"]["Enums"]["order_channel"]
          completed_at: string | null
          confirmed_at: string | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          customer_notes: string | null
          customer_phone: string | null
          delivery_address: Json | null
          delivery_fee: number
          device_id: string | null
          discount_amount: number
          held: boolean
          id: string
          kitchen_notes: string | null
          order_number: string
          promo_code: string | null
          promo_discount: number
          schedule_window_minutes: number | null
          scheduled_for: string | null
          service_fee: number
          source: string
          staff_id: string | null
          status: Database["public"]["Enums"]["order_status"]
          status_history: Json
          subtotal: number
          table_id: string | null
          tax_amount: number
          tip_amount: number
          total: number
        }
        SetofOptions: {
          from: "*"
          to: "orders"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      broadcast_franchise_menu: {
        Args: { p_source_branch_id: string; p_target_branch_ids: string[] }
        Returns: Json
      }
      cancel_order: {
        Args: { p_order_id: string; p_reason?: string }
        Returns: Json
      }
      check_gift_card: { Args: { p_code: string }; Returns: Json }
      check_plan_limit: {
        Args: { p_limit_key: string; p_restaurant_id: string }
        Returns: Json
      }
      check_rate_limit: {
        Args: {
          p_bucket_key: string
          p_max_count: number
          p_window_seconds: number
        }
        Returns: Json
      }
      clock_in: {
        Args: { p_branch_id: string; p_shift_role?: string }
        Returns: string
      }
      clock_out: { Args: { p_shift_id?: string }; Returns: string }
      create_restaurant_with_branch: {
        Args: {
          p_branch_address?: string
          p_branch_name: string
          p_branch_slug: string
          p_restaurant_name: string
          p_restaurant_slug: string
          p_theme?: Json
          p_timezone?: string
        }
        Returns: Json
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      delete_my_account: { Args: never; Returns: Json }
      driver_1099_summary: {
        Args: { p_driver_id: string; p_year: number }
        Returns: Json
      }
      driver_cancel_delivery: {
        Args: { p_delivery_id: string; p_reason?: string }
        Returns: undefined
      }
      duplicate_menu_category: {
        Args: { p_category_id: string }
        Returns: string
      }
      duplicate_menu_item: { Args: { p_item_id: string }; Returns: string }
      edit_pending_order: {
        Args: { p_items: Json; p_order_id: string }
        Returns: Json
      }
      enqueue_broadcast: { Args: { p_broadcast_id: string }; Returns: Json }
      enqueue_sync_job: {
        Args: { p_integration_id: string; p_kind: string; p_payload?: Json }
        Returns: string
      }
      export_my_data: { Args: never; Returns: Json }
      fail_delivery: {
        Args: { p_delivery_id: string; p_photo_url?: string; p_reason: string }
        Returns: undefined
      }
      find_dispatch_candidates: {
        Args: {
          p_branch_id: string
          p_exclude?: string[]
          p_radius_km?: number
        }
        Returns: {
          distance_km: number
          driver_id: string
          score: number
        }[]
      }
      forecast_orders: { Args: { p_branch_id: string }; Returns: Json }
      get_branch_reports: {
        Args: { p_branch_id: string; p_days?: number }
        Returns: Json
      }
      get_branch_reviews: {
        Args: { p_branch_id: string; p_limit?: number }
        Returns: Json
      }
      get_cohort_retention: {
        Args: { p_branch_id: string; p_weeks?: number }
        Returns: Json
      }
      get_delivery_driver_contact: {
        Args: { p_delivery_id: string }
        Returns: string
      }
      get_effective_prices: {
        Args: { p_branch_id: string }
        Returns: {
          discount_label: string
          effective_price: number
          list_price: number
          menu_item_id: string
        }[]
      }
      get_happy_hours_for_menu: {
        Args: { p_branch_id: string }
        Returns: {
          applies_to_category_ids: string[]
          applies_to_item_ids: string[]
          days_of_week: number[]
          discount_type: string
          discount_value: number
          end_time: string
          id: string
          is_live: boolean
          name: string
          start_time: string
        }[]
      }
      get_loyalty_balance: {
        Args: { p_branch_id: string }
        Returns: {
          lifetime_earned: number
          lifetime_spent: number
          points_balance: number
          scope: string
          tier: string
        }[]
      }
      get_my_driver_stats: { Args: { p_days?: number }; Returns: Json }
      get_my_plan_status: { Args: { p_restaurant_id: string }; Returns: Json }
      get_my_top_items: {
        Args: { p_branch_id: string; p_limit?: number }
        Returns: {
          last_ordered: string
          menu_item_id: string
          order_count: number
        }[]
      }
      get_or_create_my_customer: {
        Args: { p_branch_id: string }
        Returns: string
      }
      get_or_create_my_referral_code: { Args: never; Returns: string }
      get_sales_tax_report: {
        Args: { p_branch_id: string; p_from: string; p_to: string }
        Returns: Json
      }
      get_top_customers_ltv: {
        Args: { p_branch_id: string; p_limit?: number }
        Returns: {
          avg_order_value: number
          customer_id: string
          full_name: string
          last_order_at: string
          loyalty_tier: string
          total_orders: number
          total_spent: number
        }[]
      }
      increment_driver_reject_streak: {
        Args: { p_driver_id: string }
        Returns: undefined
      }
      is_branch_open: {
        Args: { p_at?: string; p_branch_id: string }
        Returns: boolean
      }
      is_delivery_participant: {
        Args: { p_delivery_id: string }
        Returns: boolean
      }
      issue_birthday_rewards: { Args: never; Returns: number }
      issue_gift_card: {
        Args: {
          p_amount: number
          p_branch_id: string
          p_message?: string
          p_recipient_email?: string
          p_recipient_name?: string
        }
        Returns: {
          code: string
          id: string
        }[]
      }
      issue_tax_invoice: {
        Args: {
          p_buyer_address?: string
          p_buyer_email?: string
          p_buyer_name?: string
          p_buyer_tax_id?: string
          p_invoice_type?: string
          p_order_id: string
        }
        Returns: {
          branch_id: string
          buyer_address: string | null
          buyer_email: string | null
          buyer_name: string
          buyer_tax_id: string | null
          canceled_at: string | null
          created_at: string
          created_by: string | null
          id: string
          invoice_number: string
          invoice_type: string
          issued_at: string | null
          line_items: Json
          order_id: string
          pdf_url: string | null
          rd_response: Json | null
          rd_submitted_at: string | null
          status: string
          subtotal: number
          total: number
          updated_at: string
          vat_amount: number
          xml_payload: string | null
        }
        SetofOptions: {
          from: "*"
          to: "tax_invoices"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      item_is_available_now: {
        Args: { p_branch_id: string; p_menu_item_id: string }
        Returns: boolean
      }
      list_my_loyalty_transactions: {
        Args: { p_branch_id: string; p_limit?: number }
        Returns: {
          balance_after: number
          branch_id: string | null
          created_at: string
          customer_id: string
          description: string | null
          expires_at: string | null
          id: string
          points: number
          reference_id: string | null
          reference_type: string | null
          restaurant_id: string | null
          type: string
        }[]
        SetofOptions: {
          from: "*"
          to: "loyalty_transactions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      mark_delivery_arriving: {
        Args: { p_delivery_id: string }
        Returns: undefined
      }
      mark_messages_read: {
        Args: { p_delivery_id: string }
        Returns: undefined
      }
      notify_waitlist_party: { Args: { p_id: string }; Returns: undefined }
      platform_ops_summary: { Args: never; Returns: Json }
      progress_delivery: {
        Args: {
          p_delivery_id: string
          p_next: Database["public"]["Enums"]["delivery_status"]
        }
        Returns: undefined
      }
      quote_delivery: {
        Args: { p_branch_id: string; p_lat: number; p_lng: number }
        Returns: Json
      }
      recall_order: { Args: { p_order_id: string }; Returns: undefined }
      recommendations_for_item: {
        Args: { p_limit?: number; p_menu_item_id: string }
        Returns: {
          co_count: number
          image_url: string
          item_name: string
          menu_item_id: string
          price: number
        }[]
      }
      recompute_loyalty_tiers: { Args: never; Returns: number }
      redeem_gift_card: {
        Args: { p_code: string; p_max_amount: number; p_order_id: string }
        Returns: number
      }
      redeem_loyalty_points: {
        Args: { p_branch_id: string; p_order_id?: string; p_points: number }
        Returns: Json
      }
      refund_order: {
        Args: { p_amount: number; p_order_id: string; p_reason?: string }
        Returns: Json
      }
      register_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_p256dh: string
          p_recipient_id: string
          p_recipient_type: string
          p_user_agent?: string
        }
        Returns: string
      }
      reject_dispatch: {
        Args: { p_delivery_id: string; p_reason?: string }
        Returns: undefined
      }
      reorder_menu_categories: {
        Args: { p_branch_id: string; p_orders: Json }
        Returns: undefined
      }
      reorder_menu_items: {
        Args: { p_branch_id: string; p_orders: Json }
        Returns: undefined
      }
      requeue_failed_delivery: {
        Args: { p_delivery_id: string }
        Returns: undefined
      }
      reset_driver_reject_streak: {
        Args: { p_driver_id: string }
        Returns: undefined
      }
      resolve_custom_domain: {
        Args: { p_domain: string }
        Returns: {
          branch_slug: string
          match_level: string
          restaurant_slug: string
        }[]
      }
      set_branch_hours: {
        Args: { p_branch_id: string; p_windows: Json }
        Returns: undefined
      }
      set_driver_kyc_status: {
        Args: {
          p_driver_id: string
          p_notes?: string
          p_status: Database["public"]["Enums"]["driver_kyc_status"]
        }
        Returns: undefined
      }
      set_driver_location: {
        Args: {
          p_battery?: number
          p_driver_id: string
          p_lat: number
          p_lng: number
        }
        Returns: undefined
      }
      set_menu_item_category: {
        Args: {
          p_branch_id: string
          p_category_id: string
          p_display_order: number
          p_item_id: string
        }
        Returns: undefined
      }
      set_restaurant_suspended: {
        Args: { p_restaurant_id: string; p_suspended: boolean }
        Returns: undefined
      }
      sweep_abandoned_carts: { Args: never; Returns: number }
      tier_for_lifetime_points: { Args: { p_points: number }; Returns: string }
      tip_pool_distribution: {
        Args: { p_branch_id: string; p_from: string; p_to: string }
        Returns: {
          hours: number
          payout: number
          share: number
          staff_email: string
          staff_member_id: string
        }[]
      }
      toggle_item_availability: {
        Args: { p_active: boolean; p_item_id: string }
        Returns: undefined
      }
      upgrade_plan: {
        Args: { p_plan_code: string; p_restaurant_id: string }
        Returns: Json
      }
      upsert_customer_address: {
        Args: {
          p_address_id?: string
          p_city: string
          p_customer_id: string
          p_is_default?: boolean
          p_label: string
          p_lat: number
          p_line1: string
          p_line2: string
          p_lng: number
          p_notes?: string
          p_postal_code: string
          p_state: string
        }
        Returns: string
      }
      validate_promo_code: {
        Args: { p_branch_id: string; p_code: string; p_subtotal: number }
        Returns: Json
      }
    }
    Enums: {
      delivery_status:
        | "pending"
        | "dispatching"
        | "assigned"
        | "picked_up"
        | "in_transit"
        | "delivered"
        | "failed"
        | "cancelled"
      driver_approval_status: "pending" | "approved" | "rejected" | "suspended"
      driver_kyc_status: "pending" | "verified" | "rejected" | "suspended"
      loyalty_tier: "bronze" | "silver" | "gold" | "platinum"
      order_channel: "dine_in" | "pickup" | "delivery" | "qr_ordering"
      order_status:
        | "pending"
        | "confirmed"
        | "preparing"
        | "ready"
        | "out_for_delivery"
        | "completed"
        | "cancelled"
        | "refunded"
      payment_status: "pending" | "completed" | "failed" | "refunded" | "voided"
      staff_role: "owner" | "manager" | "cashier" | "kitchen" | "staff"
      staff_status: "pending" | "active" | "suspended" | "removed"
      subscription_status:
        | "trialing"
        | "active"
        | "past_due"
        | "cancelled"
        | "expired"
      subscription_tier: "starter" | "pro" | "enterprise"
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
  public: {
    Enums: {
      delivery_status: [
        "pending",
        "dispatching",
        "assigned",
        "picked_up",
        "in_transit",
        "delivered",
        "failed",
        "cancelled",
      ],
      driver_approval_status: ["pending", "approved", "rejected", "suspended"],
      driver_kyc_status: ["pending", "verified", "rejected", "suspended"],
      loyalty_tier: ["bronze", "silver", "gold", "platinum"],
      order_channel: ["dine_in", "pickup", "delivery", "qr_ordering"],
      order_status: [
        "pending",
        "confirmed",
        "preparing",
        "ready",
        "out_for_delivery",
        "completed",
        "cancelled",
        "refunded",
      ],
      payment_status: ["pending", "completed", "failed", "refunded", "voided"],
      staff_role: ["owner", "manager", "cashier", "kitchen", "staff"],
      staff_status: ["pending", "active", "suspended", "removed"],
      subscription_status: [
        "trialing",
        "active",
        "past_due",
        "cancelled",
        "expired",
      ],
      subscription_tier: ["starter", "pro", "enterprise"],
    },
  },
} as const
