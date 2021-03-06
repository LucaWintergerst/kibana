/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const { unoptimizeTsConfig } = require('./optimize_tsconfig/unoptimize');

unoptimizeTsConfig().catch(err => {
  console.error(err);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
