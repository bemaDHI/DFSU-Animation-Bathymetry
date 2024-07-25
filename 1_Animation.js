// Contents
// ===================================================================================
// 1. State
// 2. Fetch Data
// 3. DeckGL Map
// 4. Custom DFS Map Layer
// 5. DFS Layer Shaders
// 6. Utils

async function main() {
    init_map();
    await load();
    update(0);
}


// 1. State
// ===================================================================================

const host = 'https://localhost:7119';
let deckglMap = null;

let vertices = null;
let attribBuffer = null;

let showTileLayer = false;
let showDepth = false;
let depthScale = 0.03;
let tileLayerId = 0;
let dfsInfo = null;
let currentTimestep = 0;


let legendColorRange = [
    { value: 0.0, color: 'rgba(  0,  65, 101, 1)' },
    { value: 0.1, color: 'rgba( 39, 116,  92, 1)' },
    { value: 0.25, color: 'rgba( 77, 167,  85, 1)' },
    { value: 0.5, color: 'rgba(131, 188,  78, 1)' },
    { value: 1.0, color: 'rgba(191, 199,  72, 1)' },
    { value: 1.25, color: 'rgba(226, 190,  70, 1)' },
    { value: 1.5, color: 'rgba(229, 158,  73, 1)' },
    { value: 2.0, color: 'rgba(220, 127,  78, 1)' }
];

let mouseX = 0;
let mouseY = 0;

window.addEventListener('mousemove', e => {
    mouseX = e.x;
    mouseY = e.y;

    if (vertices !== null && attribBuffer !== null) {
        update(currentTimestep);
    }
});

function updateShowTileLayer(cb) {
    showTileLayer = cb.checked;
    tileLayerId++

    if (vertices !== null && attribBuffer !== null) {
        update(currentTimestep);
    }
}

function updateShowDepth(cb) {
    showDepth = cb.checked;

    if (vertices !== null && attribBuffer !== null) {
        update(currentTimestep);
    }
}

function updateDepthScale(scaleInput) {
    depthScale = scaleInput.valueAsNumber;

    if (vertices !== null && attribBuffer !== null) {
        update(currentTimestep);
    }
}

function updateColorStep(stepInput) {
    const step = stepInput.valueAsNumber;
    let currValue = 0.0;

    for (let i = 0; i < legendColorRange.length; ++i) {
        legendColorRange[i].value = currValue;
        currValue += step;
    }

    // Need the reference to update for DeckGL to detect the change.
    legendColorRange = [...legendColorRange];

    if (vertices !== null && attribBuffer !== null) {
        update(currentTimestep);
    }
}


// 2. Fetch Data
// ===================================================================================

async function load() {
    // Load data for map layer.
    dfsInfo = await getDfsInfo();
    vertices = await getVertices();
    attribBuffer = await getAllTimesteps();
}

async function getDfsInfo() {
    const response = await fetch(`${host}/api/Dfsu/dfs-info`, { method: "GET" });
    const info = await response.json();
    return info;
}

async function getVertices() {
    const response = await fetch(`${host}/api/Dfsu/vertices-buffer`, { method: "GET" });
    const vboBuffer = await response.arrayBuffer();
    const vbo = new Float32Array(vboBuffer);
    return vbo;
}

async function getAllTimesteps() {
    const response = await fetch(`${host}/api/Dfsu/timestep-buffer`, { method: "GET" });
    const allTimestepsBuffer = await response.arrayBuffer();
    const allTimesteps = dfsValuesToColorBuffer(new Float32Array(allTimestepsBuffer));
    return allTimesteps;
}


// 3. DeckGL Map
// ===================================================================================

const view = new deck.MapView({
    id: 'base-map',
    controller: true,
    farZMultiplier: 2.0
});

function init_map() {
    deckglMap = new deck.Deck({
        id: 'map-app',
        parent: container,
        controller: true,
        views: view,
        initialViewState: {
            latitude: -36.8509,
            longitude: 174.7645,
            zoom: 8,
            bearing: 0,
            pitch: 30,
            minPitch: 0,
            maxPitch: 80,
            farZMultiplier: 1000.0
        },
    });
}

function update(timestep) {
    const layers = []
    if (showTileLayer) {
        layers.push(new deck.TileLayer({
            id: 'tile-layer',
            data: [
                'https://api.mapbox.com/styles/v1/mapbox/streets-v9/tiles/{z}/{x}/{y}?access_token=pk.eyJ1IjoiZGhpZ3JvdXBhdSIsImEiOiJja2ZkYTdxbDUwMXoxMnJwMng2a21ibHFtIn0.7TPV97kxQvD5xX5eai6PGQ'
            ],
            maxRequests: 20,
            pickable: false,
            highlightColor: [60, 60, 60, 40],
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            zoomOffset: devicePixelRatio === 1 ? -1 : 0,
            renderSubLayers: props => {
                const {
                    bbox: { west, south, east, north }
                } = props.tile;

                return [
                    new deck.BitmapLayer(props, {
                        data: null,
                        image: props.data,
                        bounds: [west, south, east, north],
                        parameters: { depthTest: false }
                    }),
                ];
            },
            parameters: { depthTest: false }
        }));
    }

    let verticesPerTriangle = 3;
    let triangleCount = dfsInfo?.triangleCount ?? 0;

    layers.push(new DFSULayer({
        id: `Example Binary Grid Layer ${tileLayerId}`,
        verticesBuffer: vertices,
        dfsValuesBuffer: attribBuffer.subarray(
            timestep * verticesPerTriangle * triangleCount,
            timestep * verticesPerTriangle * triangleCount + verticesPerTriangle * triangleCount),
        colorPoints: legendColorRange,
        parameters: { depthTest: true }
    }));

    deckglMap.setProps({
        layers: layers
    });
}

function animation() {
    if (attribBuffer !== null && dfsInfo !== null) {
        update((currentTimestep++ % dfsInfo.timeStepCount));
    }
    window.requestAnimationFrame(animation);
}

window.requestAnimationFrame(animation);


// 4. Custom DFS Map Layer
// =================================================================================

class DFSULayer extends deck.Layer {
    getShaders() {
        const numBands = this.props.colorPoints.length;
        const vs = getVertexShader();
        const fs = getFragmentShader(numBands);
        return super.getShaders({ vs, fs, modules: [deck.project, deck.project32, deck.picking] });
    }

    initializeState() {
        const attributeManager = this.getAttributeManager();
        const noAlloc = true;

        attributeManager.add({
            positions: {
                size: 3,
                type: 0x1406, // luma.GL.FLOAT,
                fp64: this.use64bitPositions(),
                update: (attribute) => (attribute.value = this.state.mesh.positions),
                noAlloc,
            },
            dfs_values: {
                size: 1,
                type: 0x1406, // luma.GL.FLOAT,
                update: (attribute) => (attribute.value = this.state.mesh.dfs_values),
                noAlloc,
            },
        });

        const mesh = this._createMesh();
        this.setState({
            mesh,
            ...this._getCoordinateUniforms()
        });
    }

    updateState({ props, oldProps, changeFlags }) {
        // setup model first
        if (changeFlags.extensionsChanged) {
            const { gl } = this.context;
            if (this.state.model) {
                this.state.model.delete();
            }
            this.setState({ model: this._getModel(gl) });
            this.getAttributeManager().invalidateAll();
        }

        const attributeManager = this.getAttributeManager();

        if (props.dfsValuesBuffer !== oldProps.dfsValuesBuffer) {
            const mesh = this._createMesh();
            attributeManager.invalidate("dfs_values");
            this.setState({ mesh });
        }

        if (props.colorPoints !== oldProps.colorPoints) {
            this.getShaders();
        }

        if (props._imageCoordinateSystem !== oldProps._imageCoordinateSystem) {
            this.setState(this._getCoordinateUniforms());
        }
    }

    // Override base Layer multi-depth picking logic
    disablePickingIndex() {
        this.setState({ disablePicking: true });
    }

    restorePickingColors() {
        this.setState({ disablePicking: false });
    }

    _createMesh() {
        const { verticesBuffer, dfsValuesBuffer } = this.props;

        return {
            vertexCount: verticesBuffer.length / 3,
            positions: verticesBuffer,
            dfs_values: dfsValuesBuffer,
        };
    }

    _getModel(gl) {
        if (!gl) {
            return null;
        }

        return new luma.Model(
            gl,
            Object.assign({}, this.getShaders(), {
                id: this.props.id,
                geometry: new luma.Geometry({
                    drawMode: 0x0004, //GL.TRIANGLES,
                    vertexCount: this.props.verticesBuffer.length / 3,
                }),
                isInstanced: false,
            })
        );
    }

    draw(opts) {
        const { uniforms, moduleParameters } = opts;
        const { model, disablePicking } = this.state;

        if (moduleParameters.pickingActive && disablePicking) {
            return;
        }

        const colorBandUniforms = {};
        this.props.colorPoints.forEach((colorPoint, index) => {
            colorBandUniforms[`colorBands[${index}].value`] = colorPoint.value;
            colorBandUniforms[`colorBands[${index}].color`] = convertStringToColor(
                colorPoint.color
            );
        });

        const generalUniforms = {
            screenWidth: window.innerWidth,
            mouseX: mouseX,
            showDepth: showDepth,
            depthScale: depthScale
        };

        // Render the image
        if (model) {
            model.setUniforms({ uniforms, ...colorBandUniforms, ...generalUniforms }).draw();
        }
    }

    _getCoordinateUniforms() {
        return {
            coordinateConversion: 0,
        };
    }
}

DFSULayer.layerName = "DFSULayer";


// 5. DFS Layer Shaders
// =================================================================================

function getVertexShader() {
    return `#version 300 es
#define SHADER_NAME bitmap-layer-vertex-shader

struct ColorBand {
    float value;
    vec4 color;
};

attribute vec3 positions;

attribute float dfs_values;

uniform float screenWidth;
uniform float mouseX;
uniform bool showDepth;
uniform float depthScale;

varying float dfs_value;

void main(void) {
    dfs_value = dfs_values;
    vec3 center = project_position(positions);

    if (showDepth) {
        center.z = dfs_value * depthScale;
    }
    gl_Position = project_common_position_to_clipspace(vec4(center, 1.0));
}
`;
}

function getFragmentShader(numBands) {
    return `#version 300 es
#define SHADER_NAME bitmap-layer-fragment-shader

#ifdef GL_ES
precision highp float;
#endif

struct ColorBand {
    float value;
    vec4 color;
};

varying float dfs_value;

uniform ColorBand colorBands[${numBands}];
uniform float screenWidth;
uniform float mouseX;
const float lineWidth = 2.0;

vec4 valueToColor(float value) {
    vec4 outColor = vec4(0.0);
    if (value == -999.9)
    {
        outColor = vec4(0.5, 0.5, 0.5, 1.0);
        return outColor;
    }

    if (value <= colorBands[0].value)
    {
        outColor = colorBands[0].color;
        return outColor;
    }

    for (int i = 0; i < ${numBands}; ++i) {
        
        // If you would like to remove interpolation, comment out these two lines and replace with "outColor = colorBands[i+1].color;"
        float interpolatePt = (value - colorBands[i].value) / (colorBands[i+1].value - colorBands[i].value);
        outColor = mix(colorBands[i].color, colorBands[i+1].color, interpolatePt);

        if (value <= colorBands[i+1].value) {
            break;
        }
    }
    return outColor;
}

void main(void) {
    float mousePosX = (screenWidth - (screenWidth - mouseX));
    gl_FragColor = valueToColor(dfs_value);
}
`;
}


// 6. Utils
// =================================================================================

/* 
   Duplicates the values in the DFSU timestep to correspond to each vertex in a triangle
   so that it can be used as an GLSL attribute in the shader.

   Ideally we would use a Texture Buffer Object to avoid this step but it doesn't appear
   to be supported in WebGL.
*/
function dfsValuesToColorBuffer(dfsValuesBuffer) {
    const attributeBuffer = new Float32Array(dfsValuesBuffer.length * 3);
    let j = 0;
    for (let i = 0; i < dfsValuesBuffer.length; ++i) {
        const value = dfsValuesBuffer[i];
        attributeBuffer[j++] = value;
        attributeBuffer[j++] = value;
        attributeBuffer[j++] = value;
    }
    return attributeBuffer;
}

/*
   Converts "rgba(...)" string into an array of values with the RGB channels, normalised
   between 0 and 1.
*/
const convertStringToColor = (rgbaString) => {
    const values = rgbaString
        .replace(" ", "")
        .replace("rgba(", "")
        .replace(")", "")
        .split(",");
    const r = parseInt(values[0]) / 255.0;
    const g = parseInt(values[1]) / 255.0;
    const b = parseInt(values[2]) / 255.0;
    const a = Math.round(parseFloat(values[3]) * 255) / 255.0;

    return [r, g, b, a];
};

main();
