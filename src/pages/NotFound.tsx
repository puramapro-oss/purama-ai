import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Bot, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
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
        className="text-center relative z-10"
      >
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-primary to-accent mb-6">
          <Bot className="w-10 h-10 text-primary-foreground" />
        </div>
        <h1 className="text-6xl font-orbitron font-bold gradient-text-cyan-purple mb-4">404</h1>
        <p className="text-xl text-muted-foreground mb-8">
          Oups ! Cette page n'existe pas.
        </p>
        <Button asChild className="bg-gradient-to-r from-primary to-accent hover:opacity-90">
          <Link to="/" className="inline-flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            Retour à l'accueil
          </Link>
        </Button>
      </motion.div>
    </div>
  );
}
