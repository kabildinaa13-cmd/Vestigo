"use client";

import type {ComponentProps} from 'react';
import {CaseScopeProvider} from './case-scope';
import {PlatformDashboard} from './analytics-dashboard';

type Scope=ComponentProps<typeof CaseScopeProvider>['scope'];

// Keep the provider and its consumers inside the same client boundary. The
// server supplies one serializable snapshot for SSR and initial hydration;
// no URL/localStorage fallback can turn a case into the shared archive.
export default function AnalyticsWorkspace({scope}:{scope:Scope}){
  return <CaseScopeProvider scope={scope}>
    <PlatformDashboard key={scope?`${scope.id}:${scope.currency}`:'legacy'}
      userName={scope?.number||'Общий архив'}
      userEmail={scope?'Только материалы этого дела':'Отдельно от дел'}
      isAdmin={false}/>
  </CaseScopeProvider>;
}
