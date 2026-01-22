import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, Grid3X3, List } from 'lucide-react';

interface AgentFiltersProps {
  categories: string[];
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
}

const categoryLabels: Record<string, string> = {
  all: '🎯 Tous',
  marketing: '📣 Marketing',
  email: '📧 Email',
  chatbot: '💬 Chatbot',
  sales: '💰 Ventes',
  support: '🎧 Support',
  analytics: '📊 Analytics',
  finance: '💵 Finance',
  legal: '⚖️ Légal',
  admin: '🔧 Admin',
  productivity: '⚡ Productivité',
};

export function AgentFilters({
  categories,
  selectedCategory,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
}: AgentFiltersProps) {
  const allCategories = ['all', ...categories];

  return (
    <div className="space-y-4">
      {/* Search and view toggle */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Rechercher un agent..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10 h-12 bg-input-background"
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant={viewMode === 'grid' ? 'default' : 'outline'}
            size="icon"
            onClick={() => onViewModeChange('grid')}
            className="h-12 w-12"
          >
            <Grid3X3 className="w-5 h-5" />
          </Button>
          <Button
            variant={viewMode === 'list' ? 'default' : 'outline'}
            size="icon"
            onClick={() => onViewModeChange('list')}
            className="h-12 w-12"
          >
            <List className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-2">
        {allCategories.map((category) => (
          <motion.div
            key={category}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Button
              variant={selectedCategory === category ? 'default' : 'outline'}
              size="sm"
              onClick={() => onCategoryChange(category)}
              className={
                selectedCategory === category
                  ? 'bg-gradient-to-r from-primary to-accent border-0'
                  : 'border-border hover:border-primary/50'
              }
            >
              {categoryLabels[category] || category}
            </Button>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
