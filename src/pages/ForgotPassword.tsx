import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Mail, Loader2, ArrowLeft, CheckCircle } from 'lucide-react';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isEmailSent, setIsEmailSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      toast.error('Erreur', {
        description: error.message,
      });
    } else {
      setIsEmailSent(true);
      toast.success('Email envoyé !', {
        description: 'Vérifiez votre boîte de réception.',
      });
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 grid-pattern opacity-30" />
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-accent-purple/20 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-primary/20 rounded-full blur-3xl" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
      >
        <div className="glass-effect rounded-2xl p-8">
          {!isEmailSent ? (
            <>
              {/* Header */}
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent mb-4">
                  <Mail className="w-8 h-8 text-primary-foreground" />
                </div>
                <h1 className="text-2xl font-bold gradient-text-cyan-purple mb-2">Mot de passe oublié</h1>
                <p className="text-muted-foreground">
                  Entrez votre email pour recevoir un lien de réinitialisation
                </p>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-foreground font-medium">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="vous@exemple.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10 h-12 bg-secondary border-border text-foreground placeholder:text-muted-foreground"
                      required
                    />
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full h-12 bg-gradient-to-r from-primary to-accent hover:opacity-90"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Envoi en cours...
                    </>
                  ) : (
                    'Envoyer le lien'
                  )}
                </Button>
              </form>
            </>
          ) : (
            <>
              {/* Success state */}
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-emerald to-primary mb-4">
                  <CheckCircle className="w-8 h-8 text-primary-foreground" />
                </div>
                <h1 className="text-2xl font-bold gradient-text-cyan-purple mb-2">Email envoyé !</h1>
                <p className="text-muted-foreground mb-6">
                  Un lien de réinitialisation a été envoyé à <strong className="text-foreground">{email}</strong>.
                  Vérifiez votre boîte de réception et cliquez sur le lien pour créer un nouveau mot de passe.
                </p>
                <p className="text-sm text-muted-foreground">
                  Vous n'avez pas reçu l'email ?{' '}
                  <button
                    onClick={() => setIsEmailSent(false)}
                    className="text-primary hover:underline"
                  >
                    Renvoyer
                  </button>
                </p>
              </div>
            </>
          )}

          {/* Footer */}
          <div className="mt-6 pt-6 border-t border-border">
            <Link
              to="/login"
              className="flex items-center justify-center gap-2 text-muted-foreground hover:text-primary transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Retour à la connexion
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
