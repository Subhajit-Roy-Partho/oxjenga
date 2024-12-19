import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { XRButton } from "three/addons/webxr/XRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import {
    makeDatFile,
    makeFileDropable,
    makeTopFile,
    updateStrandsFromDat
} from "./src/file.js";

import { XREstimatedLight } from "three/addons/webxr/XREstimatedLight.js";
import { establishConnection } from "./src/oxserve.js";

import { drawBox, drawCone, positionCone } from "./src/utils.js";

import {
    DNAMonomer, RNAMonomer, AminoAcidMonomer,
    Strand, System
} from "./src/system.js";

function onSelectStart(event) {

    // Do not select things if there is no system
    if (system === undefined) {
        return;
    }

    const controller = event.target;
    const intersections = getIntersections(controller);

    if (intersections.length == 0) {
        if (forces.has(controller)) {
            const f = forces.get(controller);
            scene.remove(f.coneMesh);
            forces.remove(controller);
        }
    }

    for (const intersection of intersections) {
        if (!intersection.object.isInstancedMesh) {
            continue;
        }
        const object = intersection.object;
        controller.userData.selected = object;
        controller.userData.selectedId = intersection.instanceId;

        console.log("Selected id " + intersection.instanceId);

        // Get position of the selected nucleotide
        const nucPos = system.elements.get(intersection.instanceId).position;

        // Get controller position
        const target = controller.position.clone();

        if (forces.has(controller)) {
            // Remove old cone mesh
            const f = forces.get(controller);
            scene.remove(f.coneMesh);
        }

        // Draw a "tractor beam" cone
        const pullArrow = drawCone(target, nucPos, controllerColors[controller.name]);
        scene.add(pullArrow);

        // Convert to oxDNA coordinates
        let oxDNATarget = system.instancedMesh.worldToLocal(target.clone());

        console.log(`Pull particle ${intersection.instanceId} at ${nucPos.toArray().map(v => v.toFixed(3))
        } toward ${oxDNATarget.toArray()}`);

        forces.set(controller, {
            coneMesh: pullArrow,
            target: target,
            oxDNATarget: oxDNATarget,
            nucId: intersection.instanceId
        });

        break;
    }

    let forceStr = [...forces.values()].map(f =>
        `
        {
        type = trap
        particle = ${f.nucId}
        pos0 = ${f.oxDNATarget.toArray().map(v => v.toFixed(3)).join(", ")}
        stiff = 0.1
        rate = 0.
        dir = 1.,0.,0.
        }
         `
    ).join("\n");
    console.log(forceStr);

    // Send new forces to oxDNA
    ox_socket.update_forces(forceStr);

    render();

}

function onSelectEnd(event) {

    const controller = event.target;

    if (controller.userData.selected !== undefined) {

        const object = controller.userData.selected;
        const id = controller.userData.selectedId;

        const m = new THREE.Matrix4();
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();
        object.getMatrixAt(id, m);
        m.decompose(p, q, s);
        s.divideScalar(1.2);
        m.compose(p, q, s);
        object.setMatrixAt(id, m);
        object.instanceMatrix.needsUpdate = true;

        controller.userData.selected = undefined;
    }

}

let container;
let camera, scene, renderer;
let controller1, controller2;
let controllerGrip1, controllerGrip2;

const forces = new Map();

let raycaster;
const intersected = [];
const tempMatrix = new THREE.Matrix4();

let controls, group;

// my oxDNA related mess
let box;
let system;
let ox_socket;

let stepCounter = 0;
let frameCounter = 0;
let framesSinceLastStep = 0;

const targetScale = new THREE.Vector3(1/50, 1/50, 1/50);

const controllerColors = {
    left: new THREE.Color(0x188DFF),
    right: new THREE.Color(0xFF8B17)
};

const initSceneFromJSON = (txt) => {
    // we recieve an oxView file, so it's json
    const json_data = JSON.parse(txt);

    box = new THREE.Vector3().fromArray(json_data.box);


    console.log(json_data);

    const strands = json_data.systems[0].strands;
    // Count monomers
    let n_monomers = 0;
    strands.forEach(strand => {
        n_monomers += strand.monomers.length;
    });

    // make sure we have no items in the scene group
    while (group.children.length > 0) {
        let child = group.children[0];
        group.remove(child);
        // Optional: Dispose geometry and material if they are no longer needed
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    }

    system = new System(box);
    strands.forEach(strandData => {
        const strand = new Strand(system, strandData.id);
        system.strands.push(strand);
        strandData.monomers.forEach(monomerData => {
            let monomerClass;
            switch (monomerData.class) {
            case "DNA": monomerClass = DNAMonomer; break;
            case "RNA": monomerClass = RNAMonomer; break;
            case "AA": monomerClass  = AminoAcidMonomer; break;
            default:
                throw new Error(`Unrecognised type of element:  ${monomerData.class}`);
            }

            if (system.elements.has(monomerData.id)) {
                throw "Differing id handling not inplemented yet";
            }
            const monomer = new monomerClass(
                monomerData.id,
                monomerData.type,
                strand,
                new THREE.Vector3(...monomerData.p),
                new THREE.Vector3(...monomerData.a1),
                new THREE.Vector3(...monomerData.a3)
            );
            strand.monomers.push(monomer);
        });
    });
    strands.forEach(strandData => {
        strandData.monomers.forEach(monomerData => {
            const monomer = system.elements.get(monomerData.id);
            monomer.n5 = system.elements.get(monomerData.n5);
            monomer.n3 = system.elements.get(monomerData.n3);
            monomer.pair = system.elements.get(monomerData.bp);
        });
    });
    system.placeInBox();

    system.createViewMesh();
    //const com = system.getCenterOfMass();
    //system.instancedMesh.position.add(com);

    group.add(system.instancedMesh);

    const axesHelper = new THREE.AxesHelper(10);
    const boxMesh = drawBox(box.clone());

    const origin = system.box.clone().multiplyScalar(0.5);

    system.instancedMesh.position.sub(origin);
    axesHelper.position.sub(origin);

    group.add(boxMesh);
    group.add(axesHelper);

    //generate its description in oxDNA world
    let top_file = makeTopFile(system);
    let dat_file = makeDatFile(system);

    // Establish oxServe connection and update cycles here
    ox_socket = establishConnection(
        system, top_file, dat_file, () => {
            framesSinceLastStep = 0;
            stepCounter++;
        },
        // TODO: Check more than just one monomer
        system.strands[0].monomers[0].getCategory()
    );
    console.log(ox_socket);
    window.socket = ox_socket;

    new Promise(resolve => setTimeout(resolve, 2000)).then(() => {
        // ox_socket.start_simulation();
    });

    return [strands, n_monomers];
};
const init = () => {
    container = document.createElement("div");
    container.style = "background:none";

    document.body.appendChild(container);

    makeFileDropable(container, (files) => {
        // assuming we got one file
        // -> simple parser test
        files[0].text().then(text => {
            updateStrandsFromDat(text, system);
        });
    });

    scene = new THREE.Scene();

    scene.background = new THREE.Color(0x00000, 0);

    camera = new THREE.PerspectiveCamera(
        50, window.innerWidth / window.innerHeight, 0.1, 100
    );
    camera.position.set(0, 1.6, 5);

    controls = new OrbitControls(camera, container);
    controls.update();

    let hemilight = new THREE.HemisphereLight(0x808080, 0x606060);
    hemilight.intensity = 5;

    const light = new THREE.DirectionalLight(0xffffff);
    light.position.set(0, 6, 0);
    light.intensity = 6;
    light.castShadow = true;
    light.shadow.camera.top = 2;
    light.shadow.camera.bottom = -2;
    light.shadow.camera.right = 2;
    light.shadow.camera.left = -2;
    light.shadow.mapSize.set(2048, 2048);

    let defaultLight = new THREE.Group();
    defaultLight.add(hemilight);
    defaultLight.add(light);
    scene.add(defaultLight);

    class DesignStorage {
        constructor() {
            this.counter = 0;

            this.designs = [
                //"6-bar.oxview",
                //"hairygami.oxview",
                //"hairpin.oxview",
                //"Leaf.oxview",
                //"monohole_1b.oxview",
                //"moon.oxview",
                //"meta.oxview",
                //"gated-channel.oxview",
                //"gripper.oxview",
                //"teather.oxview",
                //"planeV3.oxview",
                //"1eua.oxview",
                //"rna_crossover.oxview"
                "archana.oxview"
                //"hairygami.oxview",
            ].map(p => "resources/" + p);
        }
        getNext() {
            this.counter += 1;
            if (this.counter >= this.designs.length) this.counter = 0;
            return this.designs[this.counter];
        }
        getPrev() {
            this.counter -= 1;
            if (this.counter < 0) this.counter = this.designs.length - 1;
            return this.designs[this.counter];
        }
        getRand() {
            this.counter = Math.floor(Math.random() * this.designs.length);
            return this.designs[this.counter];
        }

    }

    let designStorage = new DesignStorage();

    //load up first design
    fetch(designStorage.getRand()).then(
        resp => resp.text()
    ).then(initSceneFromJSON);

    // read from nanobase might be subject to XSSS scripting issues ...
    // need to look more into it, but even oxview.org can't fetch in local
    // dev cycle

    // we'll use the group to add stuff as this is
    // allows for grabbing the entire thing
    group = new THREE.Group();
    group.scale.copy(targetScale);

    scene.add(group);

    renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true
    });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");
    container.appendChild(renderer.domElement);

    renderer.xr.addEventListener("sessionstart", ()=>{
        // Set small initial scale (actual oxDNA scale)
        group.scale.multiplyScalar(8.518E-10);
    });

    document.body.appendChild(XRButton.createButton(renderer, {
        optionalFeatures: ["light-estimation"]
    }));

    // Don't add the XREstimatedLight to the scene initially.
    // It doesn't have any estimated lighting values until an AR session starts.

    const xrLight = new XREstimatedLight(renderer);

    xrLight.addEventListener("estimationstart", () => {
        // Swap the default light out for the estimated one one we start
        // getting some estimated values.
        scene.add(xrLight);
        scene.remove(defaultLight);

        // The estimated lighting also provides an environment cubemap, which
        // we can apply here.
        if (xrLight.environment) {
            scene.environment = xrLight.environment;
        }

    });

    xrLight.addEventListener("estimationend", () => {
        // Swap the lights back when we stop receiving estimated values.
        scene.add(defaultLight);
        scene.remove(xrLight);
    });

    // controllers

    controller1 = renderer.xr.getController(0);
    controller1.name="left";
    controller1.addEventListener("selectstart", onSelectStart);
    controller1.addEventListener("selectend", onSelectEnd);
    scene.add(controller1);

    controller2 = renderer.xr.getController(1);
    controller2.name="right";
    controller2.addEventListener("selectstart", onSelectStart);
    controller2.addEventListener("selectend", onSelectEnd);
    scene.add(controller2);

    const controllerModelFactory = new XRControllerModelFactory();

    controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(
        controllerModelFactory.createControllerModel(controllerGrip1)
    );
    scene.add(controllerGrip1);

    controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(
        controllerModelFactory.createControllerModel(controllerGrip2)
    );
    scene.add(controllerGrip2);

    const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
    ]);

    [controller1, controller2].forEach(c=>{
        const line = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({
                color: controllerColors[c.name]
            })
        );
        line.name = "line";
        line.scale.z = 5;
        c.add(line);
    });

    raycaster = new THREE.Raycaster();

    window.addEventListener("resize", onWindowResize);
};

const onWindowResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

};

function getIntersections(controller) {

    tempMatrix.identity().extractRotation(controller.matrixWorld);

    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
    return raycaster.intersectObjects(group.children, false);
}


function intersectObjects(controller) {

    // Do not highlight when already selected
    // Do not check intersections when there is no system
    if (system === undefined ||
        controller.userData.selected !== undefined
    ) {
        return;
    }

    const line = controller.getObjectByName("line");
    const intersections = getIntersections(controller);

    if (intersections.length === 0) {
        line.scale.z = 5;
        controller.userData.highlighted = undefined;
    }
    for (const intersection of intersections) {
        if (!intersection.object.isInstancedMesh) {
            continue;
        }

        const session = renderer.xr.getSession();
        if (
            session && //only if we are in a webXR session
            // And need for a continuous haptic pulse
            intersection.instanceId === controller.userData.highlighted) {
            for (const sourceXR of session.inputSources) {
                if (!sourceXR.gamepad) continue;
                if (
                    sourceXR &&
                    sourceXR.gamepad &&
                    sourceXR.gamepad.hapticActuators &&
                    sourceXR.gamepad.hapticActuators[0] &&
                    sourceXR.handedness == controller.name
                ) {
                    sourceXR.gamepad.hapticActuators[0].pulse(0.4, 20);
                }
            }
        }

        const object = intersection.object;
        const color = new THREE.Color();
        object.getColorAt(intersection.instanceId, color);
        color.multiplyScalar(1 / 3);
        object.setColorAt(intersection.instanceId, color);
        object.instanceColor.needsUpdate = true;
        intersected.push([intersection.instanceId, object]);
        line.scale.z = intersection.distance;

        controller.userData.highlighted = intersection.instanceId;

        break;
    }

}

function cleanIntersected() {
    const color = new THREE.Color();
    while (intersected.length) {
        const [instanceId, object] = intersected.pop();
        object.getColorAt(instanceId, color);
        color.multiplyScalar(3);
        object.setColorAt(instanceId, color);
        object.instanceColor.needsUpdate = true;
    }

}


function render() {

    cleanIntersected();

    intersectObjects(controller1);
    intersectObjects(controller2);

    group.scale.lerp(targetScale, 0.01);

    renderer.render(scene, camera);

    const pulledParticles = new Set([...forces.values()].map(f => f.nucId));

    if (system !== undefined &&
        system.instancedMesh !== undefined &&
        system.elements.get(0).targetPosition !== undefined
    ) {
        const dummy = new THREE.Object3D();
        const current = new THREE.Vector3();
        const target = new THREE.Vector3();
        const m = new THREE.Matrix4();

        frameCounter++;
        framesSinceLastStep++;

        // Overestimate a bit
        const framesPerStep = 1.2 * (
            (frameCounter - framesSinceLastStep) / stepCounter
        );

        // Calculate how much to lerp this step to have linear interpolation
        let lerpFrac = Math.max(0, Math.min(1,
            (1 / (framesPerStep - framesSinceLastStep))
        ));

        if (isNaN(lerpFrac)) {
            lerpFrac = 1;
        }

        for (let i=0; i<system.idCounter; i++) {
            if (!system.elements.has(i)) {
                // Hide instance if element doesn't exist
                system.instancedMesh.setMatrixAt(
                    i, new THREE.Matrix4()
                );
                continue;
            }
            const e = system.elements.get(i);

            // Get current position
            system.instancedMesh.getMatrixAt(i, m);
            current.setFromMatrixPosition(m);

            // Get target
            e.getTargetBackbonePos(target);

            // Lerp towards new position
            current.lerp(target, lerpFrac);

            if (pulledParticles.has(i)) {
                for (const f of forces.values()) {
                    if (f.nucId === i) {
                        positionCone(
                            f.coneMesh,
                            f.target,
                            system.instancedMesh.localToWorld(current.clone())
                        );
                    }
                }
            }

            // Update instance matrix
            dummy.position.copy(current);
            dummy.updateMatrix();
            system.instancedMesh.setMatrixAt(i, dummy.matrix);
        }
        system.instancedMesh.instanceMatrix.needsUpdate = true;
    }

    renderer.setAnimationLoop(render);
}

init();
render();