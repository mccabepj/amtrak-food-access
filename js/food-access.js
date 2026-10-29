const VIEWS = {
    today: {
        title: '1. Food access today',
        field: 'today_score',

        colors: [
            '#dbe9f3',
            '#739fc1',
            '#174b72'
        ],

        outline: '#103550',

        question:
            'Is there food nearby, and does the current stop give ' +
            'passengers time to use it?',

        meaning:
            'Existing mapped food under the current timetable. ' +
            'Access and opening hours still need checking.'
    },

    platform: {
        title: '2. Food on the platform',
        field: 'platform_score',

        colors: [
            '#d9f0eb',
            '#69b8a3',
            '#146b57'
        ],

        outline: '#0e4b3d',

        question:
            'If quick food were beside the train, would today’s ' +
            'stop allow passengers to collect it?',

        meaning:
            'Assumes a six-minute collection, access and boarding ' +
            'window. This is a timing screen, not confirmed ' +
            'platform feasibility.'
    },

    longer: {
        title: '3. A longer stop',
        field: 'longer_impact_score',

        colors: [
            '#ece4f6',
            '#aa88cb',
            '#64358c'
        ],

        outline: '#462562',

        question:
            'Where would more stopping time unlock nearby food ' +
            'at a useful point in the journey?',

        meaning:
            'Shows improvement from a minimum 30-minute TOTAL stop. ' +
            'A station already passing the same access test gets ' +
            'no added benefit for that call.'
    }
};

/*
 * Initial marker styling.
 *
 * 0.95 opacity = 5% transparent.
 * Outline width is in screen pixels.
 */
const FILL_OPACITY = 0.95;
const OUTLINE_WIDTH = 0.75;

const norm = value => {
    return String(value ?? '').trim().toUpperCase();
};

const num = value => {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toFixed(1)
        : 'Not scored';
};

function el(tag, text, cls) {
    const n = document.createElement(tag);

    if (text !== undefined) {
        n.textContent = text;
    }

    if (cls) {
        n.className = cls;
    }

    return n;
}

export async function createFoodAccess({
    viewer,
    config,
    onViewChange
}) {
    const map = viewer.getMap();

    const response = await fetch(
        new URL(
            './data/food_access_v2.geojson',
            window.location.href
        )
    );

    if (!response.ok) {
        throw new Error(
            `Food data request failed: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (
        data.type !== 'FeatureCollection' ||
        !Array.isArray(data.features)
    ) {
        throw new Error('Invalid food GeoJSON.');
    }

    if (
        data.features.some(feature => {
            return !Object.hasOwn(
                feature.properties,
                'longer_impact_score'
            );
        })
    ) {
        throw new Error('Use the updated v2 data file.');
    }

    const records = new Map(
        data.features.map(feature => [
            norm(feature.properties.food_station_id),
            feature.properties
        ])
    );

    const stops = config.layers
        .filter(layer => layer.type === 'point')
        .flatMap(layer => layer.data.features);

    const stopIndex = new Map(
        stops.map(feature => [
            norm(feature.properties.stop_id),
            feature
        ])
    );

    const codeIndex = new Map();
    const byStop = new Map();

    /*
     * Match analysis stations to GTFS stations using
     * exact normalized station codes or stop IDs.
     */
    for (const feature of stops) {
        for (const value of [
            feature.properties.stop_code,
            feature.properties.stop_id
        ]) {
            const key = norm(value);

            if (key && !codeIndex.has(key)) {
                codeIndex.set(key, feature);
            }
        }
    }

    let matched = 0;

    const overlay = {
        type: 'FeatureCollection',
        features: []
    };

    for (const feature of data.features) {
        const record = feature.properties;

        const match = codeIndex.get(
            norm(record.food_station_id)
        );

        if (match) {
            matched++;

            byStop.set(
                norm(match.properties.stop_id),
                record
            );
        }

        if (!feature.geometry) {
            continue;
        }

        const properties = { ...record };

        /*
         * Keep detailed route records in the lookup,
         * rather than storing nested arrays on map features.
         */
        delete properties.directions;

        if (match?.properties.stop_id) {
            properties.stop_id = match.properties.stop_id;
        }

        overlay.features.push({
            type: 'Feature',
            properties,
            geometry: match?.geometry || feature.geometry
        });
    }

    /*
     * Allow GTFS child stops to inherit a matching
     * parent station's food assessment.
     */
    for (const feature of stops) {
        let properties = feature.properties;

        const seen = new Set();

        while (
            properties &&
            !seen.has(norm(properties.stop_id))
        ) {
            seen.add(norm(properties.stop_id));

            const record =
                records.get(norm(properties.stop_code)) ||
                records.get(norm(properties.stop_id));

            if (record) {
                byStop.set(
                    norm(feature.properties.stop_id),
                    record
                );

                break;
            }

            properties = stopIndex.get(
                norm(properties.parent_station)
            )?.properties;
        }
    }

    const layer = {
        id: 'food-access',
        name: 'Food access · study stations',
        type: 'point',
        color: VIEWS.today.colors[2],
        visible: true,
        opacity: FILL_OPACITY,
        data: overlay
    };

    map.addSource(layer.id, {
        type: 'geojson',
        data: overlay
    });

    map.addLayer(
        {
            id: layer.id,
            source: layer.id,
            type: 'circle',

            paint: {
                'circle-radius': 4,
                'circle-color': VIEWS.today.colors[1],
                'circle-opacity': FILL_OPACITY,
                'circle-stroke-width': OUTLINE_WIDTH,
                'circle-stroke-color': VIEWS.today.outline,
                'circle-stroke-opacity': 1
            }
        },
        'selected-line'
    );

    config.layers.push(layer);

    /*
     * Hide ordinary station dots initially so they
     * are not confused with assessed study stations.
     */
    for (const existingLayer of config.layers) {
        if (
            existingLayer.type === 'point' &&
            existingLayer.id !== layer.id
        ) {
            viewer.setVisibility(
                existingLayer,
                false
            );
        }
    }

    let active = 'today';

    const buttons = [
        ...document.querySelectorAll(
            '#food-views button[data-view]'
        )
    ];

    const legend = document.getElementById('food-legend');
    const question = document.getElementById('food-question');
    const count = document.getElementById('food-count');
    const zoom = document.getElementById('food-zoom');

    /*
     * Circle size always represents median CURRENT dwell.
     *
     * A minimum radius keeps zero-minute calls visible.
     * Size is capped at the equivalent of 30 minutes.
     * Changing views changes color, not circle size.
     */
    const radius = [
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
    ];

    function update() {
        const view = VIEWS[active];

        const [
            light,
            middle,
            dark
        ] = view.colors;

        /*
         * Match the selected button to its view's palette.
         */
        for (const button of buttons) {
            const selected =
                button.dataset.view === active;

            button.setAttribute(
                'aria-pressed',
                String(selected)
            );

            button.style.background =
                selected ? light : '';

            button.style.borderColor =
                selected ? middle : '';

            button.style.color =
                selected ? dark : '';
        }

        question.textContent = view.question;

        const known = [
            '==',
            ['typeof', ['get', view.field]],
            'number'
        ];

        map.setPaintProperty(
            layer.id,
            'circle-radius',
            radius
        );

        /*
         * Light-to-dark fill using the selected score.
         *
         * Unknown values remain white with a gray outline.
         */
        map.setPaintProperty(
            layer.id,
            'circle-color',

            [
                'case',
                known,

                [
                    'interpolate',
                    ['linear'],
                    ['get', view.field],

                    0, light,
                    50, middle,
                    100, dark
                ],

                '#ffffff'
            ]
        );

        /*
         * Thin dark outlines from the same color family.
         */
        map.setPaintProperty(
            layer.id,
            'circle-stroke-color',

            [
                'case',
                known,
                view.outline,
                '#899398'
            ]
        );

        map.setPaintProperty(
            layer.id,
            'circle-stroke-width',

            [
                'case',
                known,
                OUTLINE_WIDTH,
                1
            ]
        );

        /*
         * Do not reset circle-opacity here.
         * This preserves changes made with the layer slider.
         */

        legend.replaceChildren();

        legend.append(
            el(
                'p',

                active === 'longer'
                    ? 'Color: added benefit from a longer stop'
                    : 'Color: usefulness for this question',

                'legend-title'
            )
        );

        const gradient = el(
            'div',
            undefined,
            'gradient'
        );

        /*
         * Override the old fixed-blue CSS gradient.
         */
        gradient.style.background =
            `linear-gradient(to right, ${light}, ${middle}, ${dark})`;

        legend.append(gradient);

        const labels = el(
            'div',
            undefined,
            'legend-labels'
        );

        labels.append(
            el('span', '0 · lower'),
            el('span', '50'),
            el('span', '100 · higher')
        );

        legend.append(
            labels,

            el(
                'p',
                'Size: typical CURRENT stop (median)',
                'legend-title'
            )
        );

        const sizes = el(
            'div',
            undefined,
            'size-legend'
        );

        for (const minutes of [0, 5, 15, 30]) {
            const row = el(
                'span',
                undefined,
                'size-item'
            );

            const dot = el(
                'span',
                undefined,
                'size-dot'
            );

            const r = Math.sqrt(
                16 + 308 * minutes / 30
            );

            dot.style.width = `${2 * r}px`;
            dot.style.height = `${2 * r}px`;
            dot.style.background = middle;

            dot.style.border =
                `${OUTLINE_WIDTH}px solid ${view.outline}`;

            row.append(
                dot,

                document.createTextNode(
                    minutes === 30
                        ? '30+'
                        : String(minutes)
                )
            );

            sizes.append(row);
        }

        legend.append(sizes);

        const unknown = el(
            'p',
            undefined,
            'small'
        );

        unknown.append(
            el('span', undefined, 'unknown-dot'),

            document.createTextNode(
                'White/gray outline = unknown, not zero. ' +
                'Size capped at 30+ min.'
            )
        );

        legend.append(unknown);

        const scored = data.features.filter(feature => {
            return typeof feature.properties[view.field] === 'number';
        }).length;

        const first = data.features[0]?.properties;

        count.textContent =
            `${scored} scored stations · ` +
            `${matched} exact direct GTFS matches. ` +
            `Study: ${first?.assessment_start || '?'} ` +
            `to ${first?.assessment_end || '?'}.`;
    }

    for (const button of buttons) {
        button.disabled = false;

        button.addEventListener('click', () => {
            active = button.dataset.view;

            update();

            onViewChange?.();
        });
    }

    zoom.disabled = false;

    zoom.onclick = () => {
        viewer.zoomToLayer(layer);
    };

    update();

    function recordFor(feature) {
        const properties = feature?.properties || {};

        return (
            records.get(norm(properties.food_station_id)) ||
            byStop.get(norm(properties.stop_id)) ||
            records.get(norm(properties.stop_code)) ||
            null
        );
    }

    function renderDetail(container, record) {
        const view = VIEWS[active];
        const score = record[view.field];

        const [
            light,
            ,
            dark
        ] = view.colors;

        container.append(
            el(
                'p',
                record.routes,
                'station-subtitle'
            )
        );

        const result = el(
            'div',
            undefined,
            'result'
        );

        result.style.background = light;
        result.style.borderLeftColor = dark;

        const value = el(
            'strong',
            num(score)
        );

        value.style.color = dark;

        result.append(
            el('h3', view.title),
            value,
            el('p', view.meaning)
        );

        container.append(result);

        const facts = el(
            'div',
            undefined,
            'facts'
        );

        if (record.calls) {
            facts.append(
                el(
                    'div',

                    `Typical current stop: ${num(record.median_dwell)} min; ` +
                    `range ${num(record.min_dwell)}–` +
                    `${num(record.max_dwell)} min.`
                )
            );

            if (active === 'platform') {
                facts.append(
                    el(
                        'div',

                        'Platform timing assumption: six minutes for ' +
                        'collection, access and boarding.'
                    )
                );
            }

            if (active === 'longer') {
                facts.append(
                    el(
                        'div',

                        'Tested stop: at least 30 minutes total. ' +
                        'Median extra time needed: ' +
                        `${num(record.median_extra_minutes)} min.`
                    )
                );

                if (
                    score === 0 &&
                    record.food_count === 0
                ) {
                    facts.append(
                        el(
                            'div',

                            'No mapped food option was identified for ' +
                            'extra time to unlock. This is not verified absence.'
                        )
                    );
                } else if (score === 0) {
                    facts.append(
                        el(
                            'div',

                            'The extension creates no newly timing-fit ' +
                            'food access under this test: access may ' +
                            'already fit, or still not fit.'
                        )
                    );
                }

                facts.append(
                    el(
                        'div',

                        'Nearby-access timing score: ' +
                        `${num(record.nearby_before_score)} before → ` +
                        `${num(record.nearby_after_score)} after. ` +
                        'Both use the same access test.'
                    )
                );
            }

            if (record.food_count === 0) {
                facts.append(
                    el(
                        'div',
                        'Nearby food scan: no matching mapped options.'
                    )
                );
            } else if (
                typeof record.nearest_food_m === 'number'
            ) {
                facts.append(
                    el(
                        'div',

                        `${record.food_count} mapped food elements; nearest ` +
                        `${Math.round(record.nearest_food_m)} m in a ` +
                        'straight line, not a verified walk.'
                    )
                );
            }
        } else {
            facts.append(
                el(
                    'div',

                    'No eligible intermediate calls in the study. ' +
                    'Unscored is not zero.'
                )
            );
        }

        container.append(facts);

        /*
         * Display all three results, highlighting the active view.
         */
        for (const [key, item] of Object.entries(VIEWS)) {
            const row = el(
                'div',
                undefined,

                `score-row${key === active ? ' active' : ''}`
            );

            if (key === active) {
                row.style.background = light;
                row.style.color = dark;
            }

            row.append(
                el('span', item.title),
                el('span', num(record[item.field]))
            );

            container.append(row);
        }

        if (record.directions?.length) {
            const details = el(
                'details',
                undefined,
                'help'
            );

            details.append(
                el(
                    'summary',
                    'Route and direction differences'
                )
            );

            const wrap = el(
                'div',
                undefined,
                'table-wrap'
            );

            const table = el('table');
            const head = el('thead');
            const header = el('tr');

            [
                'Route / destination',
                'Typical stop',
                'Today',
                'Platform',
                'Added benefit'
            ].forEach(text => {
                header.append(
                    el('th', text)
                );
            });

            head.append(header);
            table.append(head);

            const body = el('tbody');

            for (const direction of record.directions) {
                const row = el('tr');

                [
                    `${direction.route} → ${direction.direction}`,
                    num(direction.median_dwell),
                    num(direction.today_score),
                    num(direction.platform_score),
                    num(direction.longer_impact_score)
                ].forEach(text => {
                    row.append(
                        el('td', text)
                    );
                });

                body.append(row);
            }

            table.append(body);
            wrap.append(table);
            details.append(wrap);

            container.append(details);
        }

        container.append(
            el(
                'p',

                `Assessment: ${record.assessment_start} to ` +
                `${record.assessment_end}. ` +
                `${record.calls || 0} intermediate calls. ` +
                'Scores are fixed study averages, not live conditions.',

                'small'
            )
        );

        container.append(
            el(
                'p',

                'Journey-gap weighting uses elapsed time since the ' +
                'model reference stop, not each rider’s time aboard ' +
                'or verified time since food. No demand, operating ' +
                'feasibility or safe off-train trip is established.',

                'small'
            )
        );
    }

    return {
        recordFor,
        renderDetail,
        layer
    };
}