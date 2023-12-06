import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { XRButton } from 'three/addons/webxr/XRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js'
import { makeTopFile,makeDatFile,
         oxcord_to_scene,
         updateStrandsFromDat,
         makeFileDropable
         } from './UTILS/file.js'

//import {onSelectStart, onSelectEnd} from './UTILS/selection_handlers';

import { establishConnection } from './UTILS/oxserve.js'
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js'

import { drawBox, drawCone, positionCone } from './UTILS/utils.js';

let selection_state = false 
function onSelectStart( event ) {
  selection_state = true

  const controller = event.target 

  const intersections = getIntersections( controller ) 

  if ( intersections.length > 0 ) {

    const intersection = intersections[0]

    const object = intersection.object
    controller.userData.selected = object
    controller.userData.selectedId = intersection.instanceId

    console.log("Selected id "+intersection.instanceId)

    const m = new THREE.Matrix4()
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    object.getMatrixAt(intersection.instanceId, m)
    m.decompose(p, q, s)
    s.multiplyScalar(1.2)
    m.compose(p.clone(), q, s)
    object.setMatrixAt(intersection.instanceId, m)
    object.instanceMatrix.needsUpdate = true

    const nucPos = p //object.localToWorld(p)

    //const object = intersection.object
    //object.material.emissive.b = 1
    //controller.attach( object )

    const target = controller.position.clone();

    if (forces.has(controller)) {
      // Remove old cone mesh
      const f = forces.get(controller)
      scene.remove(f.coneMesh)
    }
    const pullArrow = drawCone(target, nucPos);
    scene.add(pullArrow)

    let oxDNATarget = target.clone().sub(object.getWorldPosition(new THREE.Vector3)).multiplyScalar(50)
    oxDNATarget.applyMatrix4(object.matrixWorld.clone().invert())

    console.log(`Pull particle ${intersection.instanceId} at ${p.clone().multiplyScalar(50).toArray().map(v=>v.toFixed(3))} toward ${oxDNATarget.toArray()}`)

    forces.set(controller, {
      coneMesh: pullArrow,
      target: target,
      oxDNATarget: oxDNATarget,
      nucId: intersection.instanceId
    })


  } else {
    if (forces.has(controller)) {
      const f = forces.get(controller)
      scene.remove(f.coneMesh)
      forces.remove(controller)
    }
  }

  let forceStr = [...forces.values()].map(f=>
    `
    {
      type = trap
      particle = ${f.nucId}
      pos0 = ${f.oxDNATarget.toArray().map(v=>v.toFixed(3)).join(', ')}
      stiff = 0.1
      rate = 0.
      dir = 1.,0.,0.
    }
    `
  ).join("\n")
  console.log(forceStr)
  ox_socket.update_forces(forceStr)
  render()

}
function onSelectEnd( event ) {

  const controller = event.target

  if ( controller.userData.selected !== undefined ) {

    const object = controller.userData.selected
    const id = controller.userData.selectedId

    const m = new THREE.Matrix4()
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    object.getMatrixAt(id, m)
    m.decompose(p, q, s)
    s.divideScalar(1.2)
    m.compose(p, q, s)
    object.setMatrixAt(id, m)
    object.instanceMatrix.needsUpdate = true

    //group.attach( object )

    controller.userData.selected = undefined 
    selection_state = false
  }

}


let container
let camera, scene, renderer
let controller1, controller2
let controllerGrip1, controllerGrip2

const forces = new Map();

let raycaster
const intersected = []
const tempMatrix = new THREE.Matrix4()

let controls, group

// my oxDNA related mess 
let n_elements, strands
let box 
let instancedMesh
let ox_socket

let stepCounter = 0;
let frameCounter = 0;
let framesSinceLastStep = 0;

// Default colors for the strands
const strandColors = [
  new THREE.Color(0xfdd291), //light yellow
  new THREE.Color(0xffb322), //goldenrod
  new THREE.Color(0x437092), //dark blue
  new THREE.Color(0x6ea4cc), //light blue
] 

const strandColorsLen = strandColors.length 
    
const initSceneFromJSON = (txt) => {
  // we recieve an oxView file, so it's json
  const json_data = JSON.parse(txt)
  //console.log(json_data)

  box = new THREE.Vector3().fromArray(json_data.box)
  const origin = box.clone().divideScalar(2 * 50)
  scene.add(drawBox(box.clone().divideScalar(50)))
  const axesHelper = new THREE.AxesHelper(0.1);
  scene.add( axesHelper );

  const strands = json_data.systems[0].strands
  console.log(json_data) 
  let n_monomers = 0 
  strands.forEach(strand=>{
    n_monomers+= strand.monomers.length
    //n_monomers += (strand.end5 - strand.end3 + 1)
  })
  //console.log(n_monomers)
  const sgeometry = new THREE.SphereGeometry(0.015,6,6) 
  //const sgeometry = new THREE.IcosahedronGeometry(0.015,1)
  const material = new THREE.MeshStandardMaterial({
     roughness: 0.7,
     metalness: 0.5
   }) 

  instancedMesh = new THREE.InstancedMesh(sgeometry,material,n_monomers)
  instancedMesh.castShadow = true
  instancedMesh.receiveShadow = true
  let bid = 0

  // make sure we have no items in the scene group
  // while (group.children.length != 0 )
  // group.children.pop()
  // const group = /* your Three.js group */;
  while(group.children.length > 0) {
    let child = group.children[0];
    group.remove(child);
    // Optional: Dispose geometry and material if they are no longer needed
      if(child.geometry) child.geometry.dispose();
      if(child.material) child.material.dispose();
    }

    let round = (v)=>{
      return v.toFixed(3);
    }

    const posMap = new Map()
    const sidMap = new Map()

    let com = new THREE.Vector3()

    strands.forEach((strand, id)=>{
      // Reverse strands to keep elements on the scene 3 -> 5
      // I'll regret this deeply, but dat parsing is in order 
      strand.monomers.slice().reverse().forEach(base=>{
        //base.p = base.p.map(Math.round)

        let p = new THREE.Vector3(...base.p.map(round))
        let a1 = new THREE.Vector3(...base.a1.map(round))
        let a3 = new THREE.Vector3(...base.a3.map(round))
        let a2 = a1.clone().cross(a3)

        let bbPosition = new THREE.Vector3(
          p.x - (0.34 * a1.x + 0.3408 * a2.x),
          p.y - (0.34 * a1.y + 0.3408 * a2.y),
          p.z - (0.34 * a1.z + 0.3408 * a2.z)
        );

        //rescale everything
        bbPosition.divideScalar(50)

        com.add(bbPosition)

        posMap.set(bid, bbPosition)
        sidMap.set(bid, id)

        bid++
      })
    })

  com.divideScalar(bid)
  const shift = origin.clone().sub(com);

  //const shift = centerPositions([...posMap.values()], box.clone().divideScalar(50), origin)

  const dummy = new THREE.Object3D()
  for (let [bid, p] of posMap.entries()) {
    const sid = sidMap.get(bid)
    p.add(shift)
    dummy.position.copy(p)
    dummy.updateMatrix()
    instancedMesh.setMatrixAt(bid, dummy.matrix)
    instancedMesh.setColorAt(bid, strandColors[sid%strandColorsLen])
  }
  instancedMesh.instanceMatrix.needsUpdate = true

  group.add(instancedMesh)
  group.position.sub(origin)

  //generate it's description in oxDNA world
  let top_file = makeTopFile(strands, n_monomers)
  let dat_file = makeDatFile(strands, box, shift.clone().multiplyScalar(50))
  
  // let's establish oxServe connection and update cycles here 
  // We block the connection for now
  ox_socket = establishConnection(instancedMesh, top_file, dat_file, () => {
    framesSinceLastStep = 0
    stepCounter++
  })
  console.log(ox_socket)
  window.socket = ox_socket

  new Promise(resolve => setTimeout(resolve, 2000)).then(()=>{
    ox_socket.start_simulation()
  })

  return [strands, n_monomers]
}
const init = () => {
  container = document.createElement( 'div' )
  container.style="background:none"

  document.body.appendChild( container )

  //let's see if our dat parser workzz
  makeFileDropable(container, (files)=>{
    // assuming we got one file 
    // -> simple parser test 
    files[0].text().then(text=>{
      updateStrandsFromDat(text, instancedMesh)
    })
  })

scene = new THREE.Scene()

  //scene.background = new THREE.Color( 0x808080 )
  scene.background = new THREE.Color(0x00000,0)
//scene.background.alpha=1;
  camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 )
  camera.position.set( 0, 1.6, 5 )

  controls = new OrbitControls( camera, container )
  controls.target.set( 0, 1.6, 0 )
  controls.update()

  let hemilight =  new THREE.HemisphereLight( 0x808080, 0x606060 ) 
  hemilight.intensity=5

  const light = new THREE.DirectionalLight( 0xffffff )
  light.position.set( 0, 6, 0 )
  light.intensity=6
  light.castShadow = true
  light.shadow.camera.top = 2
  light.shadow.camera.bottom = - 2
  light.shadow.camera.right = 2
  light.shadow.camera.left = - 2
  light.shadow.mapSize.set( 2048, 2048 )
  
  let defaultLight = new THREE.Group()
  defaultLight.add(hemilight)
  defaultLight.add(light)
  scene.add(defaultLight)

  class DesignStorage{
    designs = [
      //"6-bar.oxview",
      //"hairygami.oxview",
      //"hairpin.oxview",
      //"Leaf.oxview",
      "monohole_1b.oxview",
      //"moon.oxview",
      //"meta.oxview",
      //"gated-channel.oxview",
      //"gripper.oxview",
      //"teather.oxview",
      //"planeV3.oxview"
    ] 
    constructor(){
      this.counter = 0
    }
    getNext(){
      this.counter += 1 
      if (this.counter>= this.designs.length) this.counter = 0
      return this.designs[this.counter]
    }
    getPrev(){
      this.counter -=1 
      if (this.counter<0) this.counter = this.designs.length -1
      return this.designs[this.counter]
    }
    getRand(){
      this.counter = Math.floor(Math.random()*this.designs.length)
      return this.designs[this.counter]
    }

  }

  //let s = designs[Math.floor(Math.random()*designs.length)]
  //console.log(s)
  
let designStorage = new DesignStorage()
//load up first design
fetch(designStorage.getRand()).then((resp)=>resp.text()).then(initSceneFromJSON)

  // read from nanobase might be subject to XSSS scripting issues ...
  // need to look more into it, but even oxview.org can't fetch in local dev cycle 

  // we'll use the group to add stuff as this is 
  // allows for grabbing the entire thing 
  group = new THREE.Group()

  // play with the group offset, rather than with the mesh offset
  //group.position.y += 1.5
  //group.position.z -= 2.5
  //group.rotation.y += Math.PI /2
  //group.rotation.z -= Math.PI /6

  scene.add( group )

  renderer = new THREE.WebGLRenderer( { antialias: true , alpha: true} ) 
  renderer.setPixelRatio( window.devicePixelRatio ) 
  renderer.setSize( window.innerWidth, window.innerHeight ) 
  renderer.shadowMap.enabled = true
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType("local")
  container.appendChild( renderer.domElement ) 

  document.body.appendChild( XRButton.createButton( renderer, { optionalFeatures: [ 'light-estimation' ] } ) ) 

// Don't add the XREstimatedLight to the scene initially.
// It doesn't have any estimated lighting values until an AR session starts.

const xrLight = new XREstimatedLight( renderer );

xrLight.addEventListener( 'estimationstart', () => {

// Swap the default light out for the estimated one one we start getting some estimated values.
scene.add( xrLight );
scene.remove( defaultLight );

// The estimated lighting also provides an environment cubemap, which we can apply here.
if ( xrLight.environment ) {

	scene.environment = xrLight.environment;
}
  

} );

xrLight.addEventListener( 'estimationend', () => {
  // Swap the lights back when we stop receiving estimated values.
  scene.add( defaultLight );
  scene.remove( xrLight );

  // Revert back to the default environment.
  scene.environment = defaultEnvironment;
});

  // controllers

  controller1 = renderer.xr.getController( 0 ) 
  // controller1.addEventListener( 'squeezestart', onSelectStart ) 
  // controller1.addEventListener( 'squeezeend', onSelectEnd ) 
  
  //fetch(designStorage.getRand()).then((resp)=>resp.text()).then(initSceneFromJSON)

  controller1.addEventListener( 'selectstart', onSelectStart ) 
  controller1.addEventListener( 'selectend', onSelectEnd ) 
  
  scene.add( controller1 ) 

  controller2 = renderer.xr.getController( 1 ) 
  controller2.addEventListener( 'selectstart', onSelectStart ) 
  controller2.addEventListener( 'selectend', onSelectEnd ) 
  scene.add( controller2 ) 

  const controllerModelFactory = new XRControllerModelFactory() 

  controllerGrip1 = renderer.xr.getControllerGrip( 0 ) 
  controllerGrip1.add( controllerModelFactory.createControllerModel( controllerGrip1 ) ) 
  scene.add( controllerGrip1 ) 

  controllerGrip2 = renderer.xr.getControllerGrip( 1 ) 
  controllerGrip2.add( controllerModelFactory.createControllerModel( controllerGrip2 ) ) 
  scene.add( controllerGrip2 ) 

  /*
  //handle new design loading 
  controller1.addEventListener('squeezeend',()=>{
    if(!selection_state)
      fetch(designStorage.getPrev()).then((resp)=>resp.text()).then(initSceneFromJSON)
  })
  controller2.addEventListener('squeezeend',()=>{
    if(!selection_state)
      fetch(designStorage.getNext()).then((resp)=>resp.text()).then(initSceneFromJSON)
  })
  */
   
  //

  const geometry = new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3( 0, 0, 0 ), new THREE.Vector3( 0, 0, - 1 ) ] ) 

  const line = new THREE.Line( geometry ) 
  line.name = 'line' 
  line.scale.z = 5 

  controller1.add( line.clone() ) 
  controller2.add( line.clone() ) 

  raycaster = new THREE.Raycaster() 

  //

  window.addEventListener( 'resize', onWindowResize ) 


  //work on oxserve stuff 
  //let socket = establishConnection()

  //console.log(socket)
}

const onWindowResize = () => {

  camera.aspect = window.innerWidth / window.innerHeight 
  camera.updateProjectionMatrix() 

  renderer.setSize( window.innerWidth, window.innerHeight ) 

}

function getIntersections( controller ) {

  tempMatrix.identity().extractRotation( controller.matrixWorld ) 

  raycaster.ray.origin.setFromMatrixPosition( controller.matrixWorld ) 
  raycaster.ray.direction.set( 0, 0, - 1 ).applyMatrix4( tempMatrix ) 

  //return raycaster.intersectObjects( group.children, false )
  
  return raycaster.intersectObjects(group.children, false)
  //return raycaster.intersectObjects( scene.children, false ) 
}


function intersectObjects( controller ) {

  // Do not highlight when already selected

  if ( controller.userData.selected !== undefined ) return 

  const line = controller.getObjectByName( 'line' ) 
  const intersections = getIntersections( controller ) 

  if ( intersections.length > 0 ) {

    const intersection = intersections[ 0 ] 

    // const instanceId = intersection[ 0 ].instanceId;
    // console.log("instanceID", instanceId)

    // Update targeted button state (if any)
    // console.log(intersection)
    // if ( intersection && intersection.object.isUI ) {

    //   if ( selectState ) {

    //     // Component.setState internally call component.set with the options you defined in component.setupState
    //     intersect.object.setState( 'selected' );

    //   } else {

    //     // Component.setState internally call component.set with the options you defined in component.setupState
    //     intersect.object.setState( 'hovered' );

    //   }

    // }


    const object = intersection.object 
    // console.log(
    //  intersection.instanceId
    // )

    // // intersections 
    const color = new THREE.Color()
    object.getColorAt(intersection.instanceId, color)
    color.multiplyScalar(1/3);
    object.setColorAt(intersection.instanceId, color)
    object.instanceColor.needsUpdate = true

    //object.setColorAt(instanceId, new THREE.Color("red"))

    //object.material.emissive.r = 1
    intersected.push( [intersection.instanceId, object] )


    line.scale.z = intersection.distance 

  } else {

    line.scale.z = 5 

  }

}

function cleanIntersected() {
  const color = new THREE.Color()
  while ( intersected.length ) {
    const [instanceId, object] = intersected.pop()
    object.getColorAt(instanceId, color)
    color.multiplyScalar(3);
    object.setColorAt(instanceId, color)
    object.instanceColor.needsUpdate = true
  }

}


function render() {

  cleanIntersected()

  intersectObjects(controller1)
  intersectObjects(controller2)

  renderer.render( scene, camera )

  const pulledParticles = new Set([...forces.values()].map(f=>f.nucId))

  if (instancedMesh !== undefined && instancedMesh.targetPositions !== undefined) {
    const dummy = new THREE.Object3D()
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3();

    frameCounter++;
    framesSinceLastStep++;

    // Overestimate a bit
    const framesPerStep = 1.2 * ((frameCounter - framesSinceLastStep) / stepCounter);

    // Calculate how much to lerp this step to have linear interpolation
    const lerpFrac = Math.max(0, Math.min(1,
      (1/(framesPerStep-framesSinceLastStep))
    ));

    for (const [i, bbPosition] of instancedMesh.targetPositions) {
      // Get old position
      instancedMesh.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)

      // Lerp towards new position
      p.lerp(bbPosition, lerpFrac)

      if (pulledParticles.has(i)) {
        for (const f of forces.values()) {
          if (f.nucId === i) {
            //console.log(`Nuc ${i} at ${p.clone().multiplyScalar(50).toArray().map(v=>v.toFixed(3))} pulled towards ${f.oxDNATarget.toArray().map(v=>v.toFixed(3))}`)
            positionCone(f.coneMesh, f.target, instancedMesh.localToWorld(p.clone()))
          }
        }
      }

      // Update instance matrix
      dummy.position.copy(p)
      dummy.updateMatrix()
      instancedMesh.setMatrixAt(i, dummy.matrix)
    }
    instancedMesh.instanceMatrix.needsUpdate = true
  }

  renderer.setAnimationLoop( render ) 
}

init()
render()