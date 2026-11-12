import { useEffect, useState } from 'react';
import { getAiConfig } from '@/api/ai';
import { orderModelList } from '@/lib/aiModelOrder';

const CURRENT_MODEL_KEY = 'flip7_current_model';

function readStoredModel() {
    try {
        return localStorage.getItem(CURRENT_MODEL_KEY);
    } catch {
        return null;
    }
}

function storeModel(modelId) {
    try {
        localStorage.setItem(CURRENT_MODEL_KEY, modelId);
    } catch {
        // Storage blocked (private mode): the choice lasts until the page reloads.
    }
}

/** AI scanning setup from the server; `enabled` is null until it has loaded. */
function useAiConfig() {
    const [aiConfig, setAiConfig] = useState({ enabled: null, models: [] });

    useEffect(() => {
        const loadAiConfig = async () => {
            try {
                const config = await getAiConfig();
                setAiConfig({ enabled: config.enabled, models: config.models });
            } catch (error) {
                // Treat an unreachable config like "not set up" so players can still enter scores.
                console.error('Failed to load AI config:', error);
                setAiConfig({ enabled: false, models: [] });
            }
        };

        loadAiConfig();
    }, []);

    return aiConfig;
}

/**
 * What the card scanner needs from the server: whether it is on, and the models in the order to try
 * them, with the last one that worked first.
 *
 * @returns {{enabled: boolean|null, models: object[], rememberModel: (modelId: string) => void}}
 */
export function useScanModels() {
    const aiConfig = useAiConfig();
    // May hold a model the server no longer offers; orderModelList ignores it then.
    const [currentModel, setCurrentModel] = useState(readStoredModel);

    useEffect(() => {
        if (currentModel) {
            storeModel(currentModel);
        }
    }, [currentModel]);

    return {
        enabled: aiConfig.enabled,
        models: orderModelList(aiConfig.models, currentModel),
        rememberModel: setCurrentModel,
    };
}
