'use client';

import type { ReactNode } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { ChevronDownIcon } from 'lucide-react';

export function DecisionDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible className="border-t border-border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 py-4 text-left text-sm font-medium focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-ring">
        {title}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
