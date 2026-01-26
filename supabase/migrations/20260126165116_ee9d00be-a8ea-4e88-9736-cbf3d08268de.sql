-- Fix notifications RLS policy to allow both users and service role to insert notifications
-- This fixes broken payment notifications, tier upgrade alerts, and webhook notifications

-- Drop the overly restrictive policy
DROP POLICY IF EXISTS "Users can insert their own notifications" ON public.notifications;

-- Create combined policy that allows both users and service role insertions
-- Service role operations have auth.uid() = NULL, so we check for that
CREATE POLICY "Users and service role can insert notifications"
ON public.notifications FOR INSERT
WITH CHECK (
  -- Allow service role (auth.uid() is NULL when using service role key)
  auth.uid() IS NULL
  -- OR allow users to insert their own notifications
  OR auth.uid() = user_id
);