import dotenv from 'dotenv';
dotenv.config();

export const config = {
  vaultAddress: process.env.VAULT_ADDRESS,
  vaultToken: process.env.VAULT_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseApiKey: process.env.SUPABASE_API_KEY,
};
