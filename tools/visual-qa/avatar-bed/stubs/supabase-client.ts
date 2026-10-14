// Stand-in for lib/supabase/client inside the test bed: records nothing, always succeeds.
export function createClient() {
  return { auth: { updateUser: async () => ({ data: {}, error: null }) } };
}
