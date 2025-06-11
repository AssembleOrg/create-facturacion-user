export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      afip_users: {
        Row: {
          automatic: boolean | null;
          company_name: string | null;
          cuit_company: string | null;
          id: number;
          is_company: boolean;
          password: string;
          real_name: string;
          username: string;
        };
        Insert: {
          automatic?: boolean | null;
          company_name?: string | null;
          cuit_company?: string | null;
          id?: number;
          is_company: boolean;
          password: string;
          real_name: string;
          username: string;
        };
        Update: {
          automatic?: boolean | null;
          company_name?: string | null;
          cuit_company?: string | null;
          id?: number;
          is_company?: boolean;
          password?: string;
          real_name?: string;
          username?: string;
        };
        Relationships: [];
      };
      facturacion_users: {
        Row: {
          category: string | null;
          created_at: string;
          external_client: boolean | null;
          id: number;
          maximum: number | null;
          minimum: number | null;
          password: string | null;
          real_name: string | null;
          salePoint: number | null;
          username: string | null;
          updated_at: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string;
          external_client?: boolean | null;
          id?: number;
          maximum?: number | null;
          minimum?: number | null;
          password?: string | null;
          real_name?: string | null;
          salePoint?: number | null;
          username?: string | null;
          updated_at?: string | null;
        };
        Update: {
          category?: string | null;
          created_at?: string;
          external_client?: boolean | null;
          id?: number;
          maximum?: number | null;
          minimum?: number | null;
          password?: string | null;
          real_name?: string | null;
          salePoint?: number | null;
          username?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      vep_users: {
        Row: {
          alter_name: string;
          cuit: string | null;
          execution_date: string | null;
          id: number;
          is_group: boolean;
          last_execution: string | null;
          mobile_number: string;
          need_papers: boolean | null;
          real_name: string;
        };
        Insert: {
          alter_name: string;
          cuit?: string | null;
          execution_date?: string | null;
          id?: number;
          is_group?: boolean;
          last_execution?: string | null;
          mobile_number: string;
          need_papers?: boolean | null;
          real_name: string;
        };
        Update: {
          alter_name?: string;
          cuit?: string | null;
          execution_date?: string | null;
          id?: number;
          is_group?: boolean;
          last_execution?: string | null;
          mobile_number?: string;
          need_papers?: boolean | null;
          real_name?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database[Extract<keyof Database, 'public'>];

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema['Tables'] & PublicSchema['Views'])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions['schema']]['Tables'] &
        Database[PublicTableNameOrOptions['schema']]['Views'])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions['schema']]['Tables'] &
      Database[PublicTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema['Tables'] &
        PublicSchema['Views'])
    ? (PublicSchema['Tables'] &
        PublicSchema['Views'])[PublicTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema['Tables']
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions['schema']]['Tables']
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema['Tables']
    ? PublicSchema['Tables'][PublicTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema['Tables']
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions['schema']]['Tables']
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema['Tables']
    ? PublicSchema['Tables'][PublicTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;
/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema['Enums']
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions['schema']]['Enums'][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema['Enums']
    ? PublicSchema['Enums'][PublicEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof PublicSchema['CompositeTypes']
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database;
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof PublicSchema['CompositeTypes']
    ? PublicSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;
