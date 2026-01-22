import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Agent } from '@/hooks/useAgents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Crown, Zap, ArrowRight } from 'lucide-react';

interface AgentCardProps {
  agent: Agent;
  index: number;
  onUse: (agent: Agent) => void;
}

export function AgentCard({ agent, index, onUse }: AgentCardProps) {
  const features = Array.isArray(agent.features) 
    ? agent.features 
    : [];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="futuristic-card p-6 relative group"
    >
      {/* Premium badge */}
      {agent.is_premium && (
        <div className="absolute -top-2 -right-2">
          <Badge className="bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0">
            <Crown className="w-3 h-3 mr-1" />
            Premium
          </Badge>
        </div>
      )}

      {/* Icon and color indicator */}
      <Link to={`/agent/${agent.slug}`} className="block">
        <div className="flex items-start gap-4 mb-4">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center text-2xl shrink-0 bg-secondary border border-border"
            style={agent.color ? { 
              backgroundColor: `${agent.color}20`,
              borderColor: agent.color,
            } : undefined}
          >
            {agent.icon || '🤖'}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg truncate group-hover:text-primary transition-colors">
              {agent.name}
            </h3>
            <Badge variant="secondary" className="mt-1 text-xs">
              {agent.category}
            </Badge>
          </div>
        </div>

        {/* Description */}
        <p className="text-muted-foreground text-sm line-clamp-2 mb-4">
          {agent.description || 'Agent IA pour automatiser vos tâches'}
        </p>
      </Link>

      {/* Features */}
      {features.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {features.slice(0, 3).map((feature, i) => (
            <Badge key={i} variant="outline" className="text-xs">
              {String(feature)}
            </Badge>
          ))}
          {features.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{features.length - 3}
            </Badge>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          onClick={() => onUse(agent)}
          className="flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90"
        >
          <Zap className="w-4 h-4 mr-2" />
          Utiliser
        </Button>
        <Link to={`/agent/${agent.slug}`}>
          <Button variant="outline" size="icon">
            <ArrowRight className="w-4 h-4" />
          </Button>
        </Link>
      </div>
    </motion.div>
  );
}
