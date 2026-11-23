import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPartnerContractHandler } from "./handler.ts";
import { renderContractPdf } from "./pdf.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const options = { db:{schema:"purama_ai"},auth:{persistSession:false,autoRefreshToken:false} };
const userClient = createClient(supabaseUrl,Deno.env.get("SUPABASE_ANON_KEY") ?? "",options);
const admin = createClient(supabaseUrl,serviceKey,options);
Deno.serve(createPartnerContractHandler({
  authenticate: async token => {
    const {data,error} = await userClient.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  rpc: async (name,args) => await admin.rpc(name,args),
  fetch:(input,init)=>fetch(input,init),renderPdf:renderContractPdf,
  supabaseUrl,serviceKey,
  anthropicApiKey:Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  anthropicModel:Deno.env.get("ANTHROPIC_MODEL"),
  docusealUrl:Deno.env.get("DOCUSEAL_API_URL") ?? Deno.env.get("DOCUSEAL_URL") ?? "",
  docusealKey:Deno.env.get("DOCUSEAL_API_TOKEN") ?? Deno.env.get("DOCUSEAL_API_KEY") ?? "",
}));
