-- Create a public view for the influencer leaderboard that only shows safe data
CREATE OR REPLACE VIEW public.influencer_leaderboard
WITH (security_invoker = on) AS
SELECT 
  i.id,
  i.beneficiary_name,
  i.total_sales,
  i.total_revenue,
  i.commission_tier,
  i.commission_rate,
  i.created_at,
  ROW_NUMBER() OVER (ORDER BY i.total_sales DESC, i.total_revenue DESC) as rank
FROM public.influencers i
WHERE i.contract_status = 'signed'
  AND i.total_sales > 0
ORDER BY i.total_sales DESC, i.total_revenue DESC
LIMIT 100;

-- Allow authenticated users to read the leaderboard
GRANT SELECT ON public.influencer_leaderboard TO authenticated;