-- Create influencers table
CREATE TABLE public.influencers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE,
    promo_code TEXT NOT NULL UNIQUE,
    affiliation_link TEXT NOT NULL,
    commission_rate DECIMAL(5,2) DEFAULT 20.00,
    total_revenue DECIMAL(10,2) DEFAULT 0.00,
    total_sales INTEGER DEFAULT 0,
    contract_status TEXT DEFAULT 'pending' CHECK (contract_status IN ('pending', 'signed', 'expired')),
    contract_signed_at TIMESTAMP WITH TIME ZONE,
    iban TEXT,
    beneficiary_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (now() + interval '1 month'),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create commissions table
CREATE TABLE public.commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    influencer_id UUID NOT NULL REFERENCES public.influencers(id) ON DELETE CASCADE,
    client_id UUID NOT NULL,
    sale_amount DECIMAL(10,2) NOT NULL,
    commission_amount DECIMAL(10,2) NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'validated', 'paid', 'cancelled')),
    payment_date TIMESTAMP WITH TIME ZONE,
    subscription_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.influencers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commissions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for influencers
CREATE POLICY "Influencers can view their own profile"
ON public.influencers FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Influencers can update their own profile"
ON public.influencers FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Influencers can insert their own profile"
ON public.influencers FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all influencers"
ON public.influencers FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update all influencers"
ON public.influencers FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

-- RLS Policies for commissions
CREATE POLICY "Influencers can view their own commissions"
ON public.commissions FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM public.influencers 
        WHERE influencers.id = commissions.influencer_id 
        AND influencers.user_id = auth.uid()
    )
);

CREATE POLICY "Admins can view all commissions"
ON public.commissions FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update all commissions"
ON public.commissions FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert commissions"
ON public.commissions FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Create indexes
CREATE INDEX idx_influencers_promo_code ON public.influencers(promo_code);
CREATE INDEX idx_influencers_user_id ON public.influencers(user_id);
CREATE INDEX idx_commissions_influencer_id ON public.commissions(influencer_id);
CREATE INDEX idx_commissions_status ON public.commissions(status);

-- Trigger for updated_at
CREATE TRIGGER update_influencers_updated_at
BEFORE UPDATE ON public.influencers
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Function to generate unique promo code
CREATE OR REPLACE FUNCTION public.generate_promo_code(influencer_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    base_code TEXT;
    final_code TEXT;
    counter INTEGER := 0;
BEGIN
    -- Create base code from name (uppercase, remove spaces, take first 10 chars)
    base_code := UPPER(REGEXP_REPLACE(LEFT(influencer_name, 10), '[^A-Z0-9]', '', 'g'));
    
    -- If empty, use random
    IF base_code = '' OR base_code IS NULL THEN
        base_code := 'INF';
    END IF;
    
    -- Add random suffix
    final_code := base_code || SUBSTRING(MD5(RANDOM()::TEXT), 1, 4);
    
    -- Ensure uniqueness
    WHILE EXISTS (SELECT 1 FROM public.influencers WHERE promo_code = UPPER(final_code)) LOOP
        counter := counter + 1;
        final_code := base_code || SUBSTRING(MD5(RANDOM()::TEXT || counter::TEXT), 1, 4);
    END LOOP;
    
    RETURN UPPER(final_code);
END;
$$;