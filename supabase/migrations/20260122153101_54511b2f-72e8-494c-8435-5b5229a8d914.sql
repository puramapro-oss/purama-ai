
-- Fix overly permissive RLS policy for agents admin access
-- Drop the existing permissive policy and create more specific ones
DROP POLICY IF EXISTS "Admins can manage agents" ON public.agents;

-- Create specific policies for admin operations
CREATE POLICY "Admins can insert agents" ON public.agents
    FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update agents" ON public.agents
    FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete agents" ON public.agents
    FOR DELETE USING (public.has_role(auth.uid(), 'admin'));
