/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useEffect, useMemo, useState } from 'react';
import { debounce, isEmpty, uniq, uniqBy } from 'lodash';
import {
  IngestStreamGetResponse,
  getProcessorConfig,
  UnaryOperator,
  Condition,
  processorDefinitionSchema,
  isSchema,
  FlattenRecord,
} from '@kbn/streams-schema';
import { IHttpFetchError, ResponseErrorBody } from '@kbn/core/public';
import { useDateRange } from '@kbn/observability-utils-browser/hooks/use_date_range';
import { APIReturnType } from '@kbn/streams-plugin/public/api';
import { flattenObjectNestedLast } from '@kbn/object-utils';
import { useStreamsAppFetch } from '../../../hooks/use_streams_app_fetch';
import { useKibana } from '../../../hooks/use_kibana';
import { DetectedField, ProcessorDefinitionWithUIAttributes } from '../types';
import { processorConverter } from '../utils';

export type Simulation = APIReturnType<'POST /api/streams/{name}/processing/_simulate'>;
export type ProcessorMetrics =
  Simulation['processors_metrics'][keyof Simulation['processors_metrics']];

export interface TableColumn {
  name: string;
  origin: 'processor' | 'detected';
}

export interface UseProcessingSimulatorProps {
  definition: IngestStreamGetResponse;
  processors: ProcessorDefinitionWithUIAttributes[];
}

export interface UseProcessingSimulatorReturn {
  hasLiveChanges: boolean;
  error?: IHttpFetchError<ResponseErrorBody>;
  isLoading: boolean;
  samples: FlattenRecord[];
  simulation?: Simulation | null;
  tableColumns: TableColumn[];
  refreshSamples: () => void;
  watchProcessor: (
    processor: ProcessorDefinitionWithUIAttributes | { id: string; deleteIfExists: true }
  ) => void;
}

export const useProcessingSimulator = ({
  definition,
  processors,
}: UseProcessingSimulatorProps): UseProcessingSimulatorReturn => {
  const { dependencies } = useKibana();
  const {
    data,
    streams: { streamsRepositoryClient },
  } = dependencies.start;

  const {
    absoluteTimeRange: { start, end },
  } = useDateRange({ data });

  const draftProcessors = useMemo(
    () => processors.filter((processor) => processor.status === 'draft'),
    [processors]
  );

  const [liveDraftProcessors, setLiveDraftProcessors] = useState(draftProcessors);

  useEffect(() => {
    setLiveDraftProcessors((prevLiveProcessors) => {
      const inProgressDraft = prevLiveProcessors.find((proc) => proc.id === 'draft');
      return inProgressDraft ? [...draftProcessors, inProgressDraft] : draftProcessors;
    });
  }, [draftProcessors]);

  const watchProcessor = useMemo(
    () =>
      debounce(
        (processor: ProcessorDefinitionWithUIAttributes | { id: string; deleteIfExists: true }) => {
          if ('deleteIfExists' in processor) {
            return setLiveDraftProcessors((prevLiveDraftProcessors) =>
              prevLiveDraftProcessors.filter((proc) => proc.id !== processor.id)
            );
          }

          if (processor.status === 'draft') {
            setLiveDraftProcessors((prevLiveDraftProcessors) => {
              const newLiveDraftProcessors = prevLiveDraftProcessors.slice();

              const existingIndex = prevLiveDraftProcessors.findIndex(
                (proc) => proc.id === processor.id
              );

              if (existingIndex !== -1) {
                newLiveDraftProcessors[existingIndex] = processor;
              } else {
                newLiveDraftProcessors.push(processor);
              }

              return newLiveDraftProcessors;
            });
          }
        },
        800
      ),
    []
  );

  const samplingCondition = useMemo(
    () => composeSamplingCondition(liveDraftProcessors),
    [liveDraftProcessors]
  );

  const {
    loading: isLoadingSamples,
    value: sampleDocs,
    refresh: refreshSamples,
  } = useStreamsAppFetch(
    async ({ signal }) => {
      if (!definition) {
        return [];
      }

      const samplesBody = await streamsRepositoryClient.fetch('POST /api/streams/{name}/_sample', {
        signal,
        params: {
          path: { name: definition.stream.name },
          body: {
            if: samplingCondition,
            start: start?.valueOf(),
            end: end?.valueOf(),
            size: 100,
          },
        },
      });

      return samplesBody.documents.map((doc) => flattenObjectNestedLast(doc)) as FlattenRecord[];
    },
    [definition, streamsRepositoryClient, start, end, samplingCondition],
    { disableToastOnError: true }
  );

  const {
    loading: isLoadingSimulation,
    value: simulation,
    error: simulationError,
  } = useStreamsAppFetch(
    ({ signal }): Promise<Simulation> => {
      if (!definition || isEmpty<FlattenRecord[]>(sampleDocs) || isEmpty(liveDraftProcessors)) {
        // This is a hack to avoid losing the previous value of the simulation once the conditions are not met. The state management refactor will fix this.
        return Promise.resolve(simulation!);
      }

      const processing = liveDraftProcessors.map(processorConverter.toAPIDefinition);

      const hasValidProcessors = processing.every((processor) =>
        isSchema(processorDefinitionSchema, processor)
      );

      // Each processor should meet the minimum schema requirements to run the simulation
      if (!hasValidProcessors) {
        // This is a hack to avoid losing the previous value of the simulation once the conditions are not met. The state management refactor will fix this.
        return Promise.resolve(simulation!);
      }

      return streamsRepositoryClient.fetch('POST /api/streams/{name}/processing/_simulate', {
        signal,
        params: {
          path: { name: definition.stream.name },
          body: {
            documents: sampleDocs,
            processing: liveDraftProcessors.map(processorConverter.toSimulateDefinition),
          },
        },
      });
    },
    [definition, sampleDocs, liveDraftProcessors, streamsRepositoryClient],
    { disableToastOnError: true }
  );

  const tableColumns = useMemo(() => {
    // If there is an error, we only want the source fields
    const detectedFields = simulationError ? [] : simulation?.detected_fields ?? [];

    return getTableColumns(liveDraftProcessors, detectedFields);
  }, [liveDraftProcessors, simulation, simulationError]);

  const hasLiveChanges = !isEmpty(liveDraftProcessors);

  return {
    hasLiveChanges,
    isLoading: isLoadingSamples || isLoadingSimulation,
    error: simulationError as IHttpFetchError<ResponseErrorBody> | undefined,
    refreshSamples,
    simulation,
    samples: sampleDocs ?? [],
    tableColumns,
    watchProcessor,
  };
};

const composeSamplingCondition = (
  processors: ProcessorDefinitionWithUIAttributes[]
): Condition | undefined => {
  if (isEmpty(processors)) {
    return undefined;
  }

  const uniqueFields = uniq(getSourceFields(processors));

  const conditions = uniqueFields.map((field) => ({
    field,
    operator: 'exists' as UnaryOperator,
  }));

  return { or: conditions };
};

const getSourceFields = (processors: ProcessorDefinitionWithUIAttributes[]): string[] => {
  return processors.map((processor) => getProcessorConfig(processor).field);
};

const getTableColumns = (
  processors: ProcessorDefinitionWithUIAttributes[],
  fields: DetectedField[]
) => {
  const uniqueProcessorsFields = getSourceFields(processors).map((name) => ({
    name,
    origin: 'processor',
  }));

  const uniqueDetectedFields = fields.map((field) => ({
    name: field.name,
    origin: 'detected',
  }));

  return uniqBy([...uniqueProcessorsFields, ...uniqueDetectedFields], 'name') as TableColumn[];
};
