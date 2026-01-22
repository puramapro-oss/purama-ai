-- Fix overly permissive INSERT policy for notifications
DROP POLICY "Service role can insert notifications" ON public.notifications;

-- Allow authenticated users to insert notifications for themselves
CREATE POLICY "Users can insert their own notifications"
ON public.notifications FOR INSERT
WITH CHECK (auth.uid() = user_id);