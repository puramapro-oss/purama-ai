import { afterEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({list:vi.fn(async()=>({data:[]}))}));
vi.mock("stripe",()=>({default:class {invoices={list:h.list};}}));
const {stripeListUnpaidInvoicesTool:tool}=await import("../src/tools/stripe-tool.js");
const ctx={userId:"owner",agentType:"compta" as const,mode:"live" as const};
afterEach(()=>{delete process.env.KARTA_PLATFORM_OWNER_USER_ID;vi.clearAllMocks();});
it("denies all invoice reads when no owner is configured",async()=>{delete process.env.KARTA_PLATFORM_OWNER_USER_ID;await expect(tool.execute({},ctx)).rejects.toThrow(/non autorisé/);expect(h.list).not.toHaveBeenCalled();});
it("denies another user's access to platform invoices",async()=>{process.env.KARTA_PLATFORM_OWNER_USER_ID="someone-else";await expect(tool.execute({},ctx)).rejects.toThrow(/non autorisé/);expect(h.list).not.toHaveBeenCalled();});
it("allows the explicitly configured platform owner",async()=>{process.env.KARTA_PLATFORM_OWNER_USER_ID="owner";await tool.execute({},ctx);expect(h.list).toHaveBeenCalledOnce();});
