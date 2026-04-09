import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HelpCircle, Search, ChevronDown, ChevronUp, ThumbsUp, MessageCircle, Bot, BookOpen } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useFaqArticles } from '@/hooks/useFaq';
import { Link } from 'react-router-dom';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, duration: 0.5 } }),
};

const categoryLabels: Record<string, { label: string; color: string }> = {
  general: { label: 'Général', color: 'bg-accent-cyan/20 text-accent-cyan' },
  abonnement: { label: 'Abonnement', color: 'bg-accent-purple/20 text-accent-purple' },
  parrainage: { label: 'Parrainage', color: 'bg-green-500/20 text-green-400' },
  wallet: { label: 'Wallet & Points', color: 'bg-yellow-500/20 text-yellow-400' },
  agents: { label: 'Agents IA', color: 'bg-accent-pink/20 text-accent-pink' },
  securite: { label: 'Sécurité & RGPD', color: 'bg-red-500/20 text-red-400' },
};

export default function Aide() {
  const { data: articles = [] } = useFaqArticles();
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const categories = useMemo(() => [...new Set(articles.map((a) => a.category))], [articles]);

  const filtered = useMemo(() => {
    let result = articles;
    if (activeCategory) {
      result = result.filter((a) => a.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.question.toLowerCase().includes(q) ||
          a.answer.toLowerCase().includes(q) ||
          a.search_keywords?.some((k: string) => k.toLowerCase().includes(q))
      );
    }
    return result;
  }, [articles, search, activeCategory]);

  return (
    <div className="space-y-6">
      <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={0}>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <HelpCircle className="w-7 h-7 text-accent-cyan" />
          Centre d'aide
        </h1>
        <p className="text-muted-foreground mt-1">Trouve des réponses à toutes tes questions</p>
      </motion.div>

      {/* Search */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={1}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher dans la FAQ..."
            className="pl-10 bg-card/50"
          />
        </div>
      </motion.div>

      {/* Category filters */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={2}>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={activeCategory === null ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveCategory(null)}
          >
            Tout
          </Button>
          {categories.map((cat) => {
            const c = categoryLabels[cat] || { label: cat, color: 'bg-secondary text-foreground' };
            return (
              <Button
                key={cat}
                variant={activeCategory === cat ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveCategory(cat)}
              >
                {c.label}
              </Button>
            );
          })}
        </div>
      </motion.div>

      {/* FAQ articles */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={3}>
        <Card className="bg-card/50 backdrop-blur border-border">
          <CardContent className="pt-4">
            {filtered.length === 0 ? (
              <div className="text-center py-8">
                <BookOpen className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground">Aucun résultat trouvé</p>
                <p className="text-sm text-muted-foreground/60 mt-1">Essaie avec d'autres mots-clés ou contacte le chatbot</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((article) => {
                  const isOpen = openId === article.id;
                  const c = categoryLabels[article.category] || { label: article.category, color: 'bg-secondary text-foreground' };
                  return (
                    <div key={article.id} className="py-3">
                      <button
                        onClick={() => setOpenId(isOpen ? null : article.id)}
                        className="w-full flex items-center justify-between text-left group"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Badge className={`${c.color} shrink-0 text-xs`}>{c.label}</Badge>
                          <span className="text-sm font-medium text-foreground group-hover:text-accent-cyan transition-colors truncate">
                            {article.question}
                          </span>
                        </div>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 ml-2" />
                        )}
                      </button>
                      <AnimatePresence>
                        {isOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="pt-3 pl-4 md:pl-20">
                              <p className="text-sm text-muted-foreground leading-relaxed">{article.answer}</p>
                              <div className="flex items-center gap-2 mt-3">
                                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-green-400">
                                  <ThumbsUp className="w-3 h-3 mr-1" />
                                  Utile
                                </Button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Contact / chatbot CTA */}
      <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={4}>
        <Card className="bg-gradient-to-br from-accent-purple/10 to-accent-cyan/10 border-accent-purple/20">
          <CardContent className="pt-6 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-xl bg-accent-cyan/10">
                <MessageCircle className="w-6 h-6 text-accent-cyan" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Tu n'as pas trouvé ta réponse ?</h3>
                <p className="text-sm text-muted-foreground">Notre assistant IA est disponible 24/7 pour t'aider</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Clique sur le bouton <Bot className="w-4 h-4 inline text-accent-cyan" /> en bas à droite
            </p>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
