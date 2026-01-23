-- Add commission_tier column to influencers table
ALTER TABLE public.influencers 
ADD COLUMN IF NOT EXISTS commission_tier TEXT DEFAULT 'bronze' 
CHECK (commission_tier IN ('bronze', 'silver', 'gold'));

-- Create function to calculate and update commission tier based on total_sales
CREATE OR REPLACE FUNCTION public.update_influencer_tier()
RETURNS TRIGGER AS $$
BEGIN
  -- Update tier based on total_sales
  IF NEW.total_sales >= 50 THEN
    NEW.commission_tier := 'gold';
    NEW.commission_rate := 33.00;
  ELSIF NEW.total_sales >= 20 THEN
    NEW.commission_tier := 'silver';
    NEW.commission_rate := 19.99;
  ELSE
    NEW.commission_tier := 'bronze';
    NEW.commission_rate := 9.99;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger to automatically update tier when total_sales changes
DROP TRIGGER IF EXISTS update_influencer_tier_trigger ON public.influencers;
CREATE TRIGGER update_influencer_tier_trigger
  BEFORE UPDATE OF total_sales ON public.influencers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_influencer_tier();

-- Update existing influencers to have correct tier based on current sales
UPDATE public.influencers
SET commission_tier = CASE
  WHEN total_sales >= 50 THEN 'gold'
  WHEN total_sales >= 20 THEN 'silver'
  ELSE 'bronze'
END,
commission_rate = CASE
  WHEN total_sales >= 50 THEN 33.00
  WHEN total_sales >= 20 THEN 19.99
  ELSE 9.99
END;