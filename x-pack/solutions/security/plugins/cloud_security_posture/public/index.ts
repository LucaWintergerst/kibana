/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginInitializerContext } from '@kbn/core/public';
import { CspPlugin } from './plugin';
export type { CspSecuritySolutionContext } from './types';
export type { CloudSecurityPosturePageId } from './common/navigation/types';
export { getSecuritySolutionLink } from './common/navigation/security_solution_links';

export type { CspClientPluginSetup, CspClientPluginStart } from './types';

export const plugin = (initializerContext: PluginInitializerContext) =>
  new CspPlugin(initializerContext);
