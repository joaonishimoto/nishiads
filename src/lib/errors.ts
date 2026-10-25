/** Converte erros do Supabase (Auth, PostgREST, rede) em mensagens pt-BR para a interface. */

const authMessages: Record<string, string> = {
  invalid_credentials: "E-mail ou senha incorretos.",
  email_not_confirmed: "Confirme seu e-mail antes de entrar. Procure a mensagem na sua caixa de entrada.",
  user_already_exists: "Já existe uma conta com este e-mail.",
  email_exists: "Já existe uma conta com este e-mail.",
  weak_password: "Senha fraca. Use pelo menos 8 caracteres, misturando letras e números.",
  same_password: "A nova senha precisa ser diferente da atual.",
  over_email_send_rate_limit: "Muitos e-mails enviados. Aguarde alguns minutos e tente de novo.",
  over_request_rate_limit: "Muitas tentativas. Aguarde um pouco e tente de novo.",
  signup_disabled: "Cadastros estão desativados neste ambiente.",
  session_not_found: "Sua sessão expirou. Entre novamente.",
  otp_expired: "O link expirou. Peça um novo.",
};

// Códigos que as RPCs do banco usam com mensagens já escritas em pt-BR.
const databaseCodesWithMessage = new Set(["42501", "22023", "23514", "P0002", "28000"]);

type ErrorLike = { code?: unknown; message?: unknown; name?: unknown };

export function friendlyError(error: unknown): string {
  if (!error || typeof error !== "object") return "Algo deu errado. Tente novamente.";
  const { code, message, name } = error as ErrorLike;
  const text = typeof message === "string" ? message : "";

  if (typeof code === "string") {
    const auth = authMessages[code];
    if (auth) return auth;
    if (databaseCodesWithMessage.has(code) && text) return text;
    if (code === "23505") return "Este registro já existe.";
  }

  if (name === "TypeError" && /fetch|network/i.test(text)) {
    return "Sem conexão com o servidor. Verifique sua internet e tente de novo.";
  }

  return "Algo deu errado. Tente novamente.";
}
