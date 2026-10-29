const POSITRON_URL =
    'https://tiles.openfreemap.org/styles/positron';

function absoluteResource(value, base) {
    if (
        typeof value !== 'string' ||
        /^[a-z][a-z0-9+.-]*:/i.test(value)
    ) {
        return value;
    }

    return new URL(value, base).href
        .replace(/%7B/gi, '{')
        .replace(/%7D/gi, '}');
}

async function buildBasemaps(onError) {
    const style = {
        version: 8,

        sources: {
            'basemap-osm-source': {
                type: 'raster',

                tiles: [
                    'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
                ],

                tileSize: 256,
                maxzoom: 19,

                attribution:
                    '© <a href="https://www.openstreetmap.org/copyright">' +
                    'OpenStreetMap</a> contributors'
            }
        },

        layers: [
            {
                id: 'basemap-blank',
                type: 'background',

                paint: {
                    'background-color': '#f1f2f3'
                }
            }
        ]
    };

    const grayLayers = [];

    let grayAvailable = false;

    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, 15000);

    try {
        const response = await fetch(
            POSITRON_URL,
            {
                signal: controller.signal
            }
        );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const remote = await response.json();

        if (
            remote.version !== 8 ||
            !remote.sources ||
            !Array.isArray(remote.layers)
        ) {
            throw new Error(
                'Unexpected Positron style format.'
            );
        }

        if (remote.glyphs) {
            style.glyphs = absoluteResource(
                remote.glyphs,
                POSITRON_URL
            );
        }

        if (remote.sprite) {
            style.sprite = Array.isArray(remote.sprite)
                ? remote.sprite.map(item => {
                    return {
                        ...item,

                        url: absoluteResource(
                            item.url,
                            POSITRON_URL
                        )
                    };
                })
                : absoluteResource(
                    remote.sprite,
                    POSITRON_URL
                );
        }

        const sourceIDs = new Map();

        for (
            const [id, value]
            of Object.entries(remote.sources)
        ) {
            const newID =
                `basemap-gray-source-${id}`;

            sourceIDs.set(
                id,
                newID
            );

            const source = {
                ...value
            };

            if (source.url) {
                source.url = absoluteResource(
                    source.url,
                    POSITRON_URL
                );
            }

            if (source.tiles) {
                source.tiles = source.tiles.map(url => {
                    return absoluteResource(
                        url,
                        POSITRON_URL
                    );
                });
            }

            style.sources[newID] = source;
        }

        for (const original of remote.layers) {
            const layer = {
                ...original,

                id:
                    `basemap-gray-layer-${original.id}`
            };

            if (typeof original.source === 'string') {
                layer.source = sourceIDs.get(
                    original.source
                );
            }

            layer.layout = {
                ...original.layout
            };

            grayLayers.push({
                id: layer.id,

                visibility:
                    layer.layout.visibility ||
                    'visible'
            });

            style.layers.push(layer);
        }

        grayAvailable = true;
    } catch (error) {
        onError(
            'Gray basemap could not load; normal streets are being used. ' +
            (
                error.name === 'AbortError'
                    ? 'The request timed out.'
                    : error.message
            )
        );
    } finally {
        clearTimeout(timer);
    }

    /*
     * Normal OpenStreetMap is separate from the gray basemap.
     * No grayscale filter is applied to it.
     */
    style.layers.push({
        id: 'basemap-streets',
        type: 'raster',
        source: 'basemap-osm-source',

        layout: {
            visibility:
                grayAvailable
                    ? 'none'
                    : 'visible'
        }
    });

    return {
        style,
        grayLayers,
        grayAvailable
    };
}

function visit(coords, callback) {
    if (
        !Array.isArray(coords) ||
        !coords.length
    ) {
        return;
    }

    if (typeof coords[0] === 'number') {
        callback(
            coords.slice(0, 2)
        );
    } else {
        coords.forEach(child => {
            visit(child, callback);
        });
    }
}

export async function createMap(
    config,
    onSelect,
    onError
) {
    if (!window.maplibregl) {
        throw new Error(
            'MapLibre could not load. Check your connection.'
        );
    }

    const dropdown =
        document.getElementById('basemap');

    if (dropdown) {
        dropdown.disabled = true;
    }

    const basemaps = await buildBasemaps(
        onError
    );

    /*
     * Populate the existing dropdown automatically.
     * No index.html change is needed.
     */
    if (dropdown) {
        dropdown.replaceChildren();

        const options = [
            ['gray', 'Gray · Positron'],
            ['streets', 'Normal streets'],
            ['none', 'None']
        ];

        for (const [value, label] of options) {
            const option =
                document.createElement('option');

            option.value = value;
            option.textContent = label;

            option.disabled =
                value === 'gray' &&
                !basemaps.grayAvailable;

            dropdown.append(option);
        }

        dropdown.value =
            basemaps.grayAvailable
                ? 'gray'
                : 'streets';
    }

    const map = new maplibregl.Map({
        container: 'map',

        ...config.initialView,

        style: basemaps.style
    });

    map.on('error', event => {
        onError(
            event.error?.message ||
            'A map resource failed to load.'
        );
    });

    map.addControl(
        new maplibregl.NavigationControl({
            showCompass: false
        }),
        'bottom-right'
    );

    map.addControl(
        new maplibregl.ScaleControl({
            unit: 'metric'
        }),
        'bottom-left'
    );

    await new Promise(resolve => {
        map.once('load', resolve);
    });

    if (dropdown) {
        dropdown.disabled = false;
    }

    /*
     * Add the analysis layers above both basemaps.
     * The basemap switch will not remove these layers.
     */
    [...config.layers]
        .reverse()
        .forEach(layer => {
            map.addSource(
                layer.id,
                {
                    type: 'geojson',
                    data: layer.data
                }
            );

            map.addLayer({
                id: layer.id,
                source: layer.id,

                type:
                    layer.type === 'point'
                        ? 'circle'
                        : 'line',

                layout: {
                    visibility:
                        layer.visible
                            ? 'visible'
                            : 'none',

                    ...(
                        layer.type === 'line'
                            ? {
                                'line-cap': 'round',
                                'line-join': 'round'
                            }
                            : {}
                    )
                },

                paint:
                    layer.type === 'point'
                        ? {
                            'circle-radius': 7,

                            'circle-color':
                                layer.color,

                            'circle-opacity':
                                layer.opacity,

                            'circle-stroke-width': 2,

                            'circle-stroke-color':
                                '#fffefa',

                            'circle-stroke-opacity':
                                layer.opacity
                        }
                        : {
                            'line-width':
                                layer.lineWidth ?? 4,

                            'line-color':
                                layer.color,

                            'line-opacity':
                                layer.opacity
                        }
            });
        });

    const empty = {
        type: 'FeatureCollection',
        features: []
    };

    map.addSource(
        'selection',
        {
            type: 'geojson',
            data: empty
        }
    );

    map.addLayer({
        id: 'selected-line',
        source: 'selection',
        type: 'line',

        filter: [
            '==',
            ['geometry-type'],
            'LineString'
        ],

        paint: {
            'line-color': '#d29a25',
            'line-width': 6
        }
    });

    const selectionRadius = [
        '+',
        3,

        [
            'sqrt',

            [
                '+',
                16,

                [
                    '*',
                    308,

                    [
                        '/',

                        [
                            'min',
                            30,

                            [
                                'max',
                                0,

                                [
                                    'coalesce',
                                    ['get', 'median_dwell'],
                                    0
                                ]
                            ]
                        ],

                        30
                    ]
                ]
            ]
        ]
    ];

    map.addLayer({
        id: 'selected-point',
        source: 'selection',
        type: 'circle',

        filter: [
            '==',
            ['geometry-type'],
            'Point'
        ],

        paint: {
            'circle-radius': selectionRadius,
            'circle-opacity': 0,
            'circle-stroke-color': '#263b45',
            'circle-stroke-width': 2.5
        }
    });

    function hit(point) {
        const layers = config.layers
            .filter(layer => {
                return (
                    layer.type === 'point' &&
                    layer.visible &&
                    layer.opacity > 0
                );
            })
            .map(layer => layer.id);

        if (!layers.length) {
            return [];
        }

        return map.queryRenderedFeatures(
            [
                [
                    point.x - 4,
                    point.y - 4
                ],
                [
                    point.x + 4,
                    point.y + 4
                ]
            ],

            {layers}
        );
    }

    map.on('mousemove', event => {
        map.getCanvas().style.cursor =
            hit(event.point).length
                ? 'pointer'
                : '';
    });

    map.on('click', event => {
        const feature = hit(
            event.point
        )[0];

        if (!feature) {
            return;
        }

        onSelect({
            layer: config.layers.find(layer => {
                return layer.id === feature.layer.id;
            }),

            properties: feature.properties,
            geometry: feature.geometry
        });
    });

    function fit(layers, animate = true) {
        const bounds =
            new maplibregl.LngLatBounds();

        for (const layer of layers) {
            for (const feature of layer.data.features) {
                if (!feature.geometry) {
                    continue;
                }

                visit(
                    feature.geometry.coordinates,

                    coordinate => {
                        bounds.extend(coordinate);
                    }
                );
            }
        }

        if (bounds.isEmpty()) {
            return;
        }

        map.fitBounds(
            bounds,

            {
                padding:
                    window.innerWidth > 900
                        ? {
                            top: 145,
                            right: 420,
                            bottom: 90,
                            left: 360
                        }
                        : 55,

                maxZoom: 16,

                duration:
                    animate
                        ? 700
                        : 0
            }
        );
    }

    function focusLayers() {
        const study = config.layers.filter(layer => {
            return layer.id === 'study-routes';
        });

        return study.length
            ? study
            : config.layers;
    }

    fit(
        focusLayers(),
        false
    );

    /*
     * Switch visibility, not the entire map style.
     * This preserves routes, circles and selection.
     */
    function setBasemap(value) {
        const selected =
            value === 'gray' &&
            !basemaps.grayAvailable
                ? 'streets'
                : value;

        for (const layer of basemaps.grayLayers) {
            map.setLayoutProperty(
                layer.id,
                'visibility',

                selected === 'gray'
                    ? layer.visibility
                    : 'none'
            );
        }

        map.setLayoutProperty(
            'basemap-streets',
            'visibility',

            selected === 'streets'
                ? 'visible'
                : 'none'
        );

        if (dropdown) {
            dropdown.value = selected;
        }
    }

    return {
        getMap: () => map,

        fitAll: () => {
            fit(focusLayers());
        },

        zoomToLayer: layer => {
            fit([layer]);
        },

        setBasemap,

        setVisibility(layer, value) {
            layer.visible = value;

            map.setLayoutProperty(
                layer.id,
                'visibility',

                value
                    ? 'visible'
                    : 'none'
            );
        },

        setOpacity(layer, value) {
            layer.opacity = value;

            map.setPaintProperty(
                layer.id,

                layer.type === 'point'
                    ? 'circle-opacity'
                    : 'line-opacity',

                value
            );

            if (layer.type === 'point') {
                map.setPaintProperty(
                    layer.id,
                    'circle-stroke-opacity',
                    value
                );
            }
        },

        highlight: feature => {
            map
                .getSource('selection')
                .setData(
                    feature || empty
                );
        }
    };
}