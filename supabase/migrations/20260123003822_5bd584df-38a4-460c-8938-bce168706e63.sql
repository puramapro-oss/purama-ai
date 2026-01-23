-- Drop existing trigger and function to recreate with notification logic
DROP TRIGGER IF EXISTS update_influencer_tier_trigger ON public.influencers;
DROP FUNCTION IF EXISTS public.update_influencer_tier();

-- Create improved function that tracks tier changes
CREATE OR REPLACE FUNCTION public.update_influencer_tier()
RETURNS TRIGGER AS $$
DECLARE
  old_tier TEXT;
  new_tier TEXT;
  new_rate DECIMAL;
BEGIN
  -- Store old tier
  old_tier := OLD.commission_tier;
  
  -- Calculate new tier based on total_sales
  IF NEW.total_sales >= 50 THEN
    new_tier := 'gold';
    new_rate := 33.00;
  ELSIF NEW.total_sales >= 20 THEN
    new_tier := 'silver';
    new_rate := 19.99;
  ELSE
    new_tier := 'bronze';
    new_rate := 9.99;
  END IF;
  
  -- Update the tier and rate
  NEW.commission_tier := new_tier;
  NEW.commission_rate := new_rate;
  
  -- If tier changed, trigger notification via pg_net (async HTTP call)
  IF old_tier IS DISTINCT FROM new_tier AND old_tier IS NOT NULL THEN
    -- Insert into a notification queue table for processing
    INSERT INTO public.tier_upgrade_queue (
      influencer_id,
      previous_tier,
      new_tier,
      new_rate,
      total_sales,
      created_at
    ) VALUES (
      NEW.id,
      old_tier,
      new_tier,
      new_rate,
      NEW.total_sales,
      now()
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create the tier upgrade queue table
CREATE TABLE IF NOT EXISTS public.tier_upgrade_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  influencer_id UUID NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
  previous_tier TEXT NOT NULL,
  new_tier TEXT NOT NULL,
  new_rate DECIMAL NOT NULL,
  total_sales INTEGER NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on the queue table
ALTER TABLE public.tier_upgrade_queue ENABLE ROW LEVEL SECURITY;

-- Only service role can access queue
CREATE POLICY "Service role only access" 
ON public.tier_upgrade_queue 
FOR ALL 
USING (false);

-- Recreate the trigger
CREATE TRIGGER update_influencer_tier_trigger
  BEFORE UPDATE OF total_sales ON public.influencers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_influencer_tier();