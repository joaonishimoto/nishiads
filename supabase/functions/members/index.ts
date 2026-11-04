/**
 * Convite de membro com senha inicial.
 *
 * POST /functions/v1/members   (Authorization: Bearer <access token do usuário>)
 *   { "workspace_id", "email", "role": "owner"|"admin"|"viewer", "password" }
 *   → 200 { ok: true, outcome: "created" | "added" | "already_member" | "invited" }
 *     created        conta nova criada já confirmada; a pessoa entra com o e-mail e a senha.
 *     added          a pessoa já tinha conta: entra no workspace e a senha dela não muda.
 *     already_member a pessoa já era membro.
 *     invited        existe um cadastro com o e-mail ainda não confirmado: fica como convite
 *                    e vira membro quando a pessoa confirmar o e-mail (não damos acesso a
 *                    quem não provou ser dono do e-mail).
 *   → 4xx { error: "<code>", message? }
 *   Só owner/admin; só owner concede owner.
 */
import { z } from "zod";
import { errorMessage, log } from "../_shared/log.ts";
import { createAdminClient } from "../_shared/supabase-admin.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

// Mesmas regras de senha do app (src/features/auth/schemas.ts).
const bodySchema = z.object({
  workspace_id: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["owner", "admin", "viewer"]),
  password: z.string().min(8).max(72).regex(/[a-zA-Z]/).regex(/\d/),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const admin = createAdminClient();

  const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: auth, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !auth.user) return json(401, { error: "unauthorized" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "invalid_body" });
  const { workspace_id: workspaceId, email, role, password } = parsed.data;

  const { data: caller } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!caller || !["owner", "admin"].includes(caller.role as string)) return json(403, { error: "forbidden" });
  if (role === "owner" && caller.role !== "owner") return json(403, { error: "owner_only" });

  try {
    let userId = await findUserId(admin, email);

    if (!userId) {
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created?.user) {
        await addMember(admin, workspaceId, created.user.id, role);
        log("info", "member_created", { workspaceId, userId: created.user.id, by: auth.user.id });
        return json(200, { ok: true, outcome: "created" });
      }
      // Corrida: a conta surgiu entre a busca e a criação. Segue como conta existente.
      if (createError?.code !== "email_exists") {
        if (createError?.code === "weak_password") return json(422, { error: "weak_password" });
        throw createError ?? new Error("create_user_failed");
      }
      userId = await findUserId(admin, email);
      if (!userId) throw new Error("user_not_found_after_conflict");
    }

    const { data: existing, error: getError } = await admin.auth.admin.getUserById(userId);
    if (getError) throw getError;

    if (!existing.user.email_confirmed_at) {
      const { error } = await admin.from("workspace_invitations").upsert(
        { workspace_id: workspaceId, email, role, invited_by: auth.user.id, created_at: new Date().toISOString() },
        { onConflict: "workspace_id,email" },
      );
      if (error) throw error;
      return json(200, { ok: true, outcome: "invited" });
    }

    const added = await addMember(admin, workspaceId, userId, role);
    return json(200, { ok: true, outcome: added ? "added" : "already_member" });
  } catch (cause) {
    log("error", "members_invite_failed", { workspaceId, error: errorMessage(cause) });
    return json(500, { error: "internal_error" });
  }
});

type Admin = ReturnType<typeof createAdminClient>;

/** O perfil espelha auth.users (trigger), com o e-mail em minúsculas. */
async function findUserId(admin: Admin, email: string): Promise<string | null> {
  const { data, error } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

/** Devolve false se a pessoa já era membro (o papel atual não muda). */
async function addMember(admin: Admin, workspaceId: string, userId: string, role: string): Promise<boolean> {
  const { data, error } = await admin
    .from("workspace_members")
    .upsert({ workspace_id: workspaceId, user_id: userId, role }, {
      onConflict: "workspace_id,user_id",
      ignoreDuplicates: true,
    })
    .select("user_id");
  if (error) throw error;
  return (data ?? []).length > 0;
}
