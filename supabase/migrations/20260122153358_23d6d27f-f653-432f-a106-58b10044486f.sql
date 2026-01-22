
-- Fix overly permissive "FOR ALL" policies by splitting into specific operations

-- Fix user_connections policy
DROP POLICY IF EXISTS "Users can manage their own connections" ON public.user_connections;

CREATE POLICY "Users can view their own connections" ON public.user_connections
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own connections" ON public.user_connections
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own connections" ON public.user_connections
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own connections" ON public.user_connections
    FOR DELETE USING (auth.uid() = user_id);

-- Fix scheduled_tasks policy
DROP POLICY IF EXISTS "Users can manage their own tasks" ON public.scheduled_tasks;

CREATE POLICY "Users can view their own tasks" ON public.scheduled_tasks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own tasks" ON public.scheduled_tasks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tasks" ON public.scheduled_tasks
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tasks" ON public.scheduled_tasks
    FOR DELETE USING (auth.uid() = user_id);
