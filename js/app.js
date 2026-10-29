import {config} from './config.js';
import {createMap} from './map.js';
import {createFoodAccess} from './food-access.js';

const $ = id => document.getElementById(id);

/*
 * Route IDs recorded in the supplied food-analysis workbook.
 *
 * Exact normalized route names are checked first, allowing
 * refreshed feeds to use different route IDs.
 *
 * Workbook IDs are a fallback. Check them if using another feed.
 */
const STUDY_ROUTES = [
    {
        name: 'Cardinal',
        id: '58'
    },
    {
        name: 'Silver Meteor',
        id: '42947'
    },
    {
        name: 'Southwest Chief',
        id: '51'
    }
];

/*
 * Opacity:
 * 1.00 = fully opaque
 * 0.00 = invisible
 */
const ROUTE_STYLE = {
    studyColor: '#b17638',
    studyOpacity: 0.82,
    studyWidth: 3.2,

    contextColor: '#a99076',
    contextOpacity: 0.10,
    contextWidth: 1.1
};

const normalizeName = value => {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
};

function studyRouteFor(feature) {
    const properties = feature.properties || {};

    const names = [
        properties.route_long_name,
        properties.route_short_name,
        properties.name
    ].map(normalizeName);

    const byName = STUDY_ROUTES.find(route => {
        return names.includes(
            normalizeName(route.name)
        );
    });

    if (byName) {
        return byName;
    }

    return STUDY_ROUTES.find(route => {
        return String(
            properties.route_id ?? ''
        ).trim() === route.id;
    }) || null;
}

function prepareLayers(input) {
    const pointLayers = input.filter(layer => {
        return layer.type === 'point';
    });

    const otherLayers = input.filter(layer => {
        return !['point', 'line'].includes(layer.type);
    });

    const studied = [];
    const context = [];

    const matchedNames = new Set();

    let idFallbackFeatures = 0;

    const routeLayers = input.filter(layer => {
        return layer.type === 'line';
    });

    for (const layer of routeLayers) {
        for (const feature of layer.data.features) {
            const match = studyRouteFor(feature);

            if (match) {
                studied.push(feature);
                matchedNames.add(match.name);

                const properties = feature.properties || {};

                const names = [
                    properties.route_long_name,
                    properties.route_short_name,
                    properties.name
                ].map(normalizeName);

                if (
                    !names.includes(
                        normalizeName(match.name)
                    )
                ) {
                    idFallbackFeatures++;
                }
            } else {
                context.push(feature);
            }
        }
    }

    /*
     * createMap reverses this list when drawing.
     *
     * Therefore:
     * - Context routes are drawn first.
     * - Study routes are drawn above context routes.
     * - Station markers are drawn above routes.
     */
    const layers = [...pointLayers];

    if (studied.length) {
        layers.push({
            id: 'study-routes',

            name:
                'Study routes · Cardinal / Silver Meteor / Southwest Chief',

            type: 'line',
            color: ROUTE_STYLE.studyColor,
            opacity: ROUTE_STYLE.studyOpacity,
            lineWidth: ROUTE_STYLE.studyWidth,
            visible: true,

            data: {
                type: 'FeatureCollection',
                features: studied
            }
        });
    }

    if (context.length) {
        layers.push({
            id: 'context-routes',
            name: 'Other rail routes · faint context',
            type: 'line',
            color: ROUTE_STYLE.contextColor,
            opacity: ROUTE_STYLE.contextOpacity,
            lineWidth: ROUTE_STYLE.contextWidth,
            visible: true,

            data: {
                type: 'FeatureCollection',
                features: context
            }
        });
    }

    layers.push(...otherLayers);

    return {
        layers,
        matchedNames: [...matchedNames],
        idFallbackFeatures,
        studyFeatures: studied.length,
        contextFeatures: context.length
    };
}

let viewer = null;
let food = null;
let selected = null;

const worker = new Worker(
    new URL(
        './gtfs-headway-worker.js',
        import.meta.url
    )
);

const pending = new Map();

let nextId = 0;

function status(text) {
    $('status').textContent = text;
    $('status').hidden = false;
}

worker.onmessage = event => {
    const message = event.data;

    if (message.type === 'progress') {
        status(message.text);
        return;
    }

    const request = pending.get(message.id);

    if (!request) {
        return;
    }

    pending.delete(message.id);

    if (message.type === 'error') {
        request.reject(
            new Error(message.text)
        );
    } else {
        request.resolve(message.result);
    }
};

worker.onerror = event => {
    const error = new Error(
        event.message ||
        'GTFS worker could not load.'
    );

    pending.forEach(request => {
        request.reject(error);
    });

    pending.clear();

    status(error.message);
};

function query(action, payload) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;

        pending.set(id, {
            resolve,
            reject
        });

        worker.postMessage({
            id,
            action,
            payload
        });
    });
}

function layersOpen(open) {
    $('layers-panel').hidden = !open;

    $('layers-toggle').setAttribute(
        'aria-expanded',
        String(open)
    );
}

$('layers-toggle').onclick = () => {
    layersOpen(
        $('layers-panel').hidden
    );
};

$('layers-close').onclick = () => {
    layersOpen(false);
};

$('basemap').onchange = event => {
    viewer?.setBasemap(
        event.target.value
    );
};

$('reset').onclick = () => {
    viewer?.fitAll();
};

function closeInspector() {
    selected = null;

    $('inspector').hidden = true;

    viewer?.highlight(null);
}

$('inspect-close').onclick = closeInspector;

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        closeInspector();
    }
});

function element(tag, text) {
    const n = document.createElement(tag);

    if (text !== undefined) {
        n.textContent = text;
    }

    return n;
}

function renderLayers() {
    const list = $('layer-list');

    list.replaceChildren();

    for (const layer of config.layers) {
        const item = element('article');

        item.className = 'layer';

        const label = element('label');
        const check = element('input');

        check.type = 'checkbox';
        check.checked = layer.visible;

        check.onchange = () => {
            viewer.setVisibility(
                layer,
                check.checked
            );
        };

        const swatch = element('span');

        swatch.className = 'swatch';
        swatch.style.background = layer.color;

        if (layer.type === 'point') {
            swatch.style.borderRadius = '50%';
        } else {
            swatch.style.height = '3px';
        }

        label.append(
            check,
            swatch,
            element('span', layer.name)
        );

        const details = element('details');
        const options = element('div');

        options.className = 'options';

        const opacityLabel = element(
            'label',
            `Opacity: ${Math.round(layer.opacity * 100)}%`
        );

        const range = element('input');

        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.value = layer.opacity * 100;

        range.setAttribute(
            'aria-label',
            `${layer.name} opacity`
        );

        range.oninput = () => {
            opacityLabel.textContent =
                `Opacity: ${range.value}%`;

            viewer.setOpacity(
                layer,
                Number(range.value) / 100
            );
        };

        const zoom = element(
            'button',
            'Zoom to layer'
        );

        zoom.type = 'button';

        zoom.onclick = () => {
            viewer.zoomToLayer(layer);
        };

        options.append(
            opacityLabel,
            range,
            zoom
        );

        details.append(
            element('summary', 'Display options'),
            options
        );

        item.append(label, details);
        list.append(item);
    }
}

function showStation(feature) {
    const record = food?.recordFor(feature);

    if (!record) {
        return;
    }

    selected = feature;

    $('inspect-title').textContent =
        record.name;

    $('inspect-body').replaceChildren();

    food.renderDetail(
        $('inspect-body'),
        record
    );

    $('inspector').hidden = false;

    layersOpen(false);

    /*
     * Pass the station's properties into the selection layer,
     * so its outline can follow the dwell-based circle size.
     */
    viewer.highlight({
        type: 'Feature',
        properties: feature.properties || {},
        geometry: feature.geometry
    });
}

async function start() {
    try {
        $('title').textContent = config.title;
        document.title = config.title;

        const result = await query('load', {
            url: new URL(
                config.gtfsUrl,
                window.location.href
            ).href,

            colors: config.colors
        });

        const prepared = prepareLayers(
            result.layers
        );

        config.layers = prepared.layers;

        const summary = result.summary;

        if (!config.layers.length) {
            throw new Error(
                'No usable rail map features found.'
            );
        }

        $('subtitle').textContent =
            'Amber: study routes · faint lines: other rail routes';

        $('feed-info').textContent =
            `${summary.stations.toLocaleString()} rail locations. ` +
            'Study routes identified: ' +
            `${prepared.matchedNames.join(', ') || 'none'}. ` +
            `${prepared.studyFeatures} study shape features; ` +
            `${prepared.contextFeatures} context shape features. ` +
            `Calendar bounds: ${summary.calendarRange}. ` +
            'Food scores use a fixed study period.';

        const warnings = [
            ...summary.warnings
        ];

        const missing = STUDY_ROUTES.filter(route => {
            return !prepared.matchedNames.includes(
                route.name
            );
        });

        if (missing.length) {
            warnings.push(
                'No supplied route geometry matched: ' +
                `${missing.map(route => route.name).join(', ')}. ` +
                'Check route names/IDs in this feed; ' +
                'no geometry was invented.'
            );
        }

        if (prepared.idFallbackFeatures) {
            warnings.push(
                `${prepared.idFallbackFeatures} shape features ` +
                'matched analysis-workbook route IDs rather than ' +
                'exact route names. Check these IDs if using ' +
                'a different GTFS feed.'
            );
        }

        $('feed-warning').textContent =
            warnings.join(' ');

        status('Drawing map…');

        let mapError = null;

        viewer = await createMap(
            config,
            showStation,
            message => {
                mapError = message;

                status(
                    `Map resource error: ${message}`
                );
            }
        );

        try {
            food = await createFoodAccess({
                viewer,
                config,

                onViewChange: () => {
                    if (selected) {
                        showStation(selected);
                    }
                }
            });
        } catch (error) {
            console.warn(error);

            $('food-question').textContent =
                'Food data could not load. Check ' +
                'data/food_access_v2.geojson and the browser console.';

            $('feed-warning').textContent +=
                ` Food assessment unavailable: ${error.message}`;
        }

        renderLayers();

        if (mapError) {
            status(
                `Map resource error: ${mapError}`
            );
        } else {
            $('status').hidden = true;
        }
    } catch (error) {
        console.error(error);

        status(
            error.message ||
            'Viewer could not start.'
        );
    }
}

start();