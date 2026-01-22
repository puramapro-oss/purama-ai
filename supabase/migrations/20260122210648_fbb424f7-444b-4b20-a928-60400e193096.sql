-- Create table for Starter plan users to select their 5 agents
CREATE TABLE public.user_agent_selections (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now(),
    UNIQUE(user_id, agent_id)
);

-- Enable RLS
ALTER TABLE public.user_agent_selections ENABLE ROW LEVEL SECURITY;

-- Users can view their own selections
CREATE POLICY "Users can view their own agent selections"
ON public.user_agent_selections
FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own selections (limited by app logic to 5)
CREATE POLICY "Users can insert their own agent selections"
ON public.user_agent_selections
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can delete their own selections
CREATE POLICY "Users can delete their own agent selections"
ON public.user_agent_selections
FOR DELETE
USING (auth.uid() = user_id);