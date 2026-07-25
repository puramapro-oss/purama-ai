export const SUPER_ADMIN_EMAIL = 'matiss.frasne@gmail.com';

export function isSuperAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().trim() === SUPER_ADMIN_EMAIL;
}
