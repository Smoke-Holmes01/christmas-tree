import { useState, useMemo, useRef, useEffect, useCallback, Suspense } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import {
  OrbitControls,
  Environment,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles,
  useTexture
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

type SceneState = 'CHAOS' | 'FORMED';
type QualityPreset = 'HIGH' | 'LOW';

// --- 动态生成照片列表 (top.jpg + 1.jpg 到 8.jpg) ---
const TOTAL_NUMBERED_PHOTOS = 8;
const bodyPhotoPaths = [
  '/photos/top.jpg',
  ...Array.from({ length: TOTAL_NUMBERED_PHOTOS }, (_, i) => `/photos/${i + 1}.jpg`)
];

const PHOTO_PATHS = {
  // top 属性不再需要，因为已经移入 body
  body: bodyPhotoPaths
};

// --- 固定视觉配置（与性能模式无关） ---
const COLORS = {
  emerald: '#004225', // 纯正祖母绿
  gold: '#FFD700',
  silver: '#ECEFF1',
  red: '#D32F2F',
  green: '#2E7D32',
  white: '#FFFFFF',   // 纯白色
  warmLight: '#FFD54F',
  lights: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'], // 彩灯
  // 拍立得边框颜色池 (复古柔和色系)
  borders: ['#FFFAF0', '#F0E68C', '#E6E6FA', '#FFB6C1', '#98FB98', '#87CEFA', '#FFDAB9'],
  // 圣诞元素颜色
  giftColors: ['#D32F2F', '#FFD700', '#1976D2', '#2E7D32'],
  candyColors: ['#FF0000', '#FFFFFF']
} as const;

const TREE = { height: 22, radius: 9 } as const;

type PerfConfig = {
  counts: {
    foliage: number;
    ornaments: number;
    elements: number;
    lights: number;
  };
  graphics: {
    dpr: number | [number, number];
    starsCount: number;
    sparklesCount: number;
    enableEnvironment: boolean;
    enablePostprocessing: boolean;
    bloom: {
      intensity: number;
      luminanceThreshold: number;
      luminanceSmoothing: number;
      radius: number;
      mipmapBlur: boolean;
    };
  };
  mediapipe: {
    preferredDelegate: 'GPU' | 'CPU';
    maxFps: number;
    videoConstraints: MediaStreamConstraints['video'];
  };
  geometry: {
    glowSegments: number;
  };
  materials: {
    unlitPhotos: boolean;
  };
};

const PERF_PRESETS: Record<QualityPreset, PerfConfig> = {
  HIGH: {
    counts: {
      foliage: 15000,
      ornaments: 300,
      elements: 200,
      lights: 400
    },
    graphics: {
      dpr: [1, 2],
      starsCount: 5000,
      sparklesCount: 600,
      enableEnvironment: true,
      enablePostprocessing: true,
      bloom: { luminanceThreshold: 0.8, luminanceSmoothing: 0.1, intensity: 1.5, radius: 0.5, mipmapBlur: true }
    },
    mediapipe: {
      preferredDelegate: 'GPU',
      maxFps: 24,
      videoConstraints: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } }
    },
    geometry: { glowSegments: 12 },
    materials: { unlitPhotos: false }
  },
  LOW: {
    counts: {
      foliage: 6000,
      ornaments: 100,
      elements: 80,
      lights: 150
    },
    graphics: {
      dpr: 1,
      starsCount: 2000,
      sparklesCount: 250,
      enableEnvironment: false,
      enablePostprocessing: false,
      bloom: { luminanceThreshold: 1, luminanceSmoothing: 0.1, intensity: 0.8, radius: 0.4, mipmapBlur: false }
    },
    mediapipe: {
      preferredDelegate: 'CPU',
      maxFps: 15,
      videoConstraints: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 } }
    },
    geometry: { glowSegments: 8 },
    materials: { unlitPhotos: true }
  }
};

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(COLORS.emerald), uProgress: 0 },
  `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
  `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = TREE.height; const rBase = TREE.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Foliage ---
const Foliage = ({ state, count }: { state: SceneState; count: number }) => {
  const materialRef = useRef<any>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, [count]);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
  });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
        <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
      </bufferGeometry>
      {/* @ts-ignore */}
      <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

// --- Component: Photo Ornaments (变形效果：照片 ↔ 发光粒子) ---
const PhotoOrnaments = ({
  state,
  count,
  photos,
  glowSegments,
  unlitPhotos,
}: {
  state: SceneState;
  count: number;
  photos: string[];
  glowSegments: number;
  unlitPhotos: boolean;
}) => {
  const textures = useTexture(photos);
  const groupRef = useRef<THREE.Group>(null);
  
  // 存储每个元素的变形进度 (0 = 照片, 1 = 发光粒子)
  const morphProgressRef = useRef<number[]>([]);
  useEffect(() => {
    morphProgressRef.current = new Array(count).fill(0);
  }, [count]);

  const borderGeometry = useMemo(() => new THREE.PlaneGeometry(1.2, 1.5), []);
  const photoGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const glowGeometry = useMemo(() => new THREE.SphereGeometry(0.25, glowSegments, glowSegments), [glowSegments]);
  
  // 发光粒子的颜色池 - 圣诞主题
  const glowColors = useMemo(() => [
    '#FFD700', // 金色
    '#FF6B6B', // 红色
    '#4ECDC4', // 青色
    '#45B7D1', // 蓝色
    '#96CEB4', // 薄荷绿
    '#FFEAA7', // 淡黄
    '#DDA0DD', // 梅红
    '#98D8C8', // 薄荷
  ], []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map((_, i) => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*70, (Math.random()-0.5)*70, (Math.random()-0.5)*70);
      const h = TREE.height; const y = (Math.random() * h) - (h / 2);
      const rBase = TREE.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.5;
      const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const isBig = Math.random() < 0.2;
      const baseScale = isBig ? 2.2 : 0.8 + Math.random() * 0.6;
      const weight = 0.8 + Math.random() * 1.2;
      const borderColor = COLORS.borders[Math.floor(Math.random() * COLORS.borders.length)];
      const glowColor = glowColors[Math.floor(Math.random() * glowColors.length)];

      const rotationSpeed = {
        x: (Math.random() - 0.5) * 1.0,
        y: (Math.random() - 0.5) * 1.0,
        z: (Math.random() - 0.5) * 1.0
      };
      const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

      // 发光粒子的脉冲参数
      const pulseSpeed = 1.5 + Math.random() * 2;
      const pulseOffset = Math.random() * Math.PI * 2;

      return {
        chaosPos, targetPos, scale: baseScale, weight,
        textureIndex: i % textures.length,
        borderColor,
        glowColor,
        currentPos: chaosPos.clone(),
        chaosRotation,
        rotationSpeed,
        wobbleOffset: Math.random() * 10,
        wobbleSpeed: 0.5 + Math.random() * 0.5,
        pulseSpeed,
        pulseOffset,
        // 变形延迟，让粒子依次变形而不是同时
        morphDelay: Math.random() * 0.5
      };
    });
  }, [textures, count, glowColors]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;

    groupRef.current.children.forEach((group, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;

      // 更新变形进度 (FORMED 时变为粒子，CHAOS 时变回照片)
      const targetMorph = isFormed ? 1 : 0;
      const morphSpeed = 2.0; // 变形速度
      morphProgressRef.current[i] = MathUtils.damp(
        morphProgressRef.current[i], 
        targetMorph, 
        morphSpeed, 
        delta
      );
      const morph = morphProgressRef.current[i];

      objData.currentPos.lerp(target, delta * (isFormed ? 0.8 * objData.weight : 0.5));
      group.position.copy(objData.currentPos);

      // 获取子元素
      const photoGroup = group.children[0] as THREE.Group; // 照片组
      const glowMesh = group.children[1] as THREE.Mesh;    // 发光球

      if (photoGroup && glowMesh) {
        // 照片：随着 morph 增加而缩小并变透明
        const photoScale = 1 - morph * 0.8; // 缩小到 20%
        photoGroup.scale.setScalar(photoScale);
        
        // 更新照片材质透明度
        photoGroup.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.material) return;
          const material = mesh.material;
          const applyOpacity = (m: THREE.Material) => {
            m.opacity = 1 - morph;
            m.transparent = true;
          };
          if (Array.isArray(material)) material.forEach(applyOpacity);
          else applyOpacity(material as THREE.Material);
        });

        // 发光球：随着 morph 增加而放大并变亮
        const glowScale = morph * 0.6;
        glowMesh.scale.setScalar(Math.max(0.01, glowScale)); // 避免 scale 为 0
        
        const glowMat = glowMesh.material as THREE.MeshStandardMaterial;
        glowMat.opacity = morph * 0.85;
        // 脉冲发光效果
        const pulse = (Math.sin(time * objData.pulseSpeed + objData.pulseOffset) + 1) / 2;
        glowMat.emissiveIntensity = morph * (0.8 + pulse * 1.2);
      }

      if (isFormed) {
         const targetLookPos = new THREE.Vector3(group.position.x * 2, group.position.y + 0.5, group.position.z * 2);
         group.lookAt(targetLookPos);

         const wobbleX = Math.sin(time * objData.wobbleSpeed + objData.wobbleOffset) * 0.05;
         const wobbleZ = Math.cos(time * objData.wobbleSpeed * 0.8 + objData.wobbleOffset) * 0.05;
         group.rotation.x += wobbleX;
         group.rotation.z += wobbleZ;

      } else {
         group.rotation.x += delta * objData.rotationSpeed.x;
         group.rotation.y += delta * objData.rotationSpeed.y;
         group.rotation.z += delta * objData.rotationSpeed.z;
      }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => (
        <group key={i} scale={[obj.scale, obj.scale, obj.scale]} rotation={state === 'CHAOS' ? obj.chaosRotation : [0,0,0]}>
          {/* 照片组 */}
          <group>
            {/* 正面 */}
            <group position={[0, 0, 0.015]}>
              <mesh geometry={photoGeometry}>
                {unlitPhotos ? (
                  <meshBasicMaterial map={textures[obj.textureIndex]} side={THREE.FrontSide} transparent />
                ) : (
                  <meshStandardMaterial
                    map={textures[obj.textureIndex]}
                    roughness={0.5} metalness={0}
                    emissive={COLORS.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                    side={THREE.FrontSide}
                    transparent
                  />
                )}
              </mesh>
              <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
                {unlitPhotos ? (
                  <meshBasicMaterial color={obj.borderColor} side={THREE.FrontSide} transparent />
                ) : (
                  <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} transparent />
                )}
              </mesh>
            </group>
            {/* 背面 */}
            <group position={[0, 0, -0.015]} rotation={[0, Math.PI, 0]}>
              <mesh geometry={photoGeometry}>
                {unlitPhotos ? (
                  <meshBasicMaterial map={textures[obj.textureIndex]} side={THREE.FrontSide} transparent />
                ) : (
                  <meshStandardMaterial
                    map={textures[obj.textureIndex]}
                    roughness={0.5} metalness={0}
                    emissive={COLORS.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                    side={THREE.FrontSide}
                    transparent
                  />
                )}
              </mesh>
              <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
                {unlitPhotos ? (
                  <meshBasicMaterial color={obj.borderColor} side={THREE.FrontSide} transparent />
                ) : (
                  <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} transparent />
                )}
              </mesh>
            </group>
          </group>
          
          {/* 发光粒子球 */}
          <mesh geometry={glowGeometry} scale={0.01}>
            <meshStandardMaterial 
              color={obj.glowColor}
              emissive={obj.glowColor}
              emissiveIntensity={0}
              transparent
              opacity={0}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
};

// --- Component: Christmas Elements ---
const ChristmasElements = ({ state, count }: { state: SceneState; count: number }) => {
  const groupRef = useRef<THREE.Group>(null);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(0.8, 0.8, 0.8), []);
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(0.5, 16, 16), []);
  const caneGeometry = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = TREE.height;
      const y = (Math.random() * h) - (h / 2);
      const rBase = TREE.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) * 0.95;
      const theta = Math.random() * Math.PI * 2;

      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const type = Math.floor(Math.random() * 3);
      let color; let scale = 1;
      if (type === 0) { color = COLORS.giftColors[Math.floor(Math.random() * COLORS.giftColors.length)]; scale = 0.8 + Math.random() * 0.4; }
      else if (type === 1) { color = COLORS.giftColors[Math.floor(Math.random() * COLORS.giftColors.length)]; scale = 0.6 + Math.random() * 0.4; }
      else { color = Math.random() > 0.5 ? COLORS.red : COLORS.white; scale = 0.7 + Math.random() * 0.3; }

      const rotationSpeed = { x: (Math.random()-0.5)*2.0, y: (Math.random()-0.5)*2.0, z: (Math.random()-0.5)*2.0 };
      return { type, chaosPos, targetPos, color, scale, currentPos: chaosPos.clone(), chaosRotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI), rotationSpeed };
    });
  }, [boxGeometry, sphereGeometry, caneGeometry, count]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    groupRef.current.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh;
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 1.5);
      mesh.position.copy(objData.currentPos);
      mesh.rotation.x += delta * objData.rotationSpeed.x; mesh.rotation.y += delta * objData.rotationSpeed.y; mesh.rotation.z += delta * objData.rotationSpeed.z;
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => {
        let geometry; if (obj.type === 0) geometry = boxGeometry; else if (obj.type === 1) geometry = sphereGeometry; else geometry = caneGeometry;
        return ( <mesh key={i} scale={[obj.scale, obj.scale, obj.scale]} geometry={geometry} rotation={obj.chaosRotation}>
          <meshStandardMaterial color={obj.color} roughness={0.3} metalness={0.4} emissive={obj.color} emissiveIntensity={0.2} />
        </mesh> )})}
    </group>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state, count }: { state: SceneState; count: number }) => {
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = TREE.height; const y = (Math.random() * h) - (h / 2); const rBase = TREE.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = COLORS.lights[Math.floor(Math.random() * COLORS.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, [count]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh;
      mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
    </group>
  );
};

// --- Component: Top Star (No Photo, Pure Gold 3D Star) ---
const TopStar = ({ state }: { state: SceneState }) => {
  const groupRef = useRef<THREE.Group>(null);

  const starShape = useMemo(() => {
    const shape = new THREE.Shape();
    const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath();
    return shape;
  }, []);

  const starGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, // 增加一点厚度
      bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3,
    });
  }, [starShape]);

  // 纯金材质
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: COLORS.gold,
    emissive: COLORS.gold,
    emissiveIntensity: 1.5, // 适中亮度，既发光又有质感
    roughness: 0.1,
    metalness: 1.0,
  }), []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });

  return (
    <group ref={groupRef} position={[0, TREE.height / 2 + 1.8, 0]}>
      <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}>
        <mesh geometry={starGeometry} material={goldMaterial} />
      </Float>
    </group>
  );
};

// --- Main Scene Experience ---
const Experience = ({ sceneState, rotationSpeed, perf }: { sceneState: SceneState; rotationSpeed: number; perf: PerfConfig }) => {
  const controlsRef = useRef<any>(null);
  useFrame(() => {
    if (controlsRef.current) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + rotationSpeed);
      controlsRef.current.update();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 8, 60]} fov={45} />
      <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={rotationSpeed === 0 && sceneState === 'FORMED'} autoRotateSpeed={0.3} maxPolarAngle={Math.PI / 1.7} />

      <color attach="background" args={['#000300']} />
      <Stars radius={100} depth={50} count={perf.graphics.starsCount} factor={4} saturation={0} fade speed={1} />
      {perf.graphics.enableEnvironment ? <Environment preset="night" background={false} /> : null}

      <ambientLight intensity={0.4} color="#003311" />
      <pointLight position={[30, 30, 30]} intensity={100} color={COLORS.warmLight} />
      <pointLight position={[-30, 10, -30]} intensity={50} color={COLORS.gold} />
      <pointLight position={[0, -20, 10]} intensity={30} color="#ffffff" />

      <group position={[0, -6, 0]}>
        <Foliage state={sceneState} count={perf.counts.foliage} />
        <Suspense fallback={null}>
           <PhotoOrnaments
             state={sceneState}
             count={perf.counts.ornaments}
             photos={PHOTO_PATHS.body}
             glowSegments={perf.geometry.glowSegments}
             unlitPhotos={perf.materials.unlitPhotos}
           />
           <ChristmasElements state={sceneState} count={perf.counts.elements} />
           <FairyLights state={sceneState} count={perf.counts.lights} />
           <TopStar state={sceneState} />
        </Suspense>
        <Sparkles count={perf.graphics.sparklesCount} scale={50} size={8} speed={0.4} opacity={0.4} color={COLORS.silver} />
      </group>

      {perf.graphics.enablePostprocessing ? (
        <EffectComposer>
          <Bloom
            luminanceThreshold={perf.graphics.bloom.luminanceThreshold}
            luminanceSmoothing={perf.graphics.bloom.luminanceSmoothing}
            intensity={perf.graphics.bloom.intensity}
            radius={perf.graphics.bloom.radius}
            mipmapBlur={perf.graphics.bloom.mipmapBlur}
          />
          <Vignette eskil={false} offset={0.1} darkness={1.2} />
        </EffectComposer>
      ) : null}
    </>
  );
};

// --- Helper: 计算两点之间的距离 ---
const getDistance = (p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number }) => {
  return Math.sqrt(
    Math.pow(p1.x - p2.x, 2) +
    Math.pow(p1.y - p2.y, 2) +
    Math.pow(p1.z - p2.z, 2)
  );
};

// --- Helper: 检测三指捏合 (大拇指、食指、中指) ---
const detectThreeFingerPinch = (landmarks: { x: number; y: number; z: number }[]): boolean => {
  // 手部关键点索引:
  // 4: THUMB_TIP (大拇指尖)
  // 8: INDEX_FINGER_TIP (食指尖)
  // 12: MIDDLE_FINGER_TIP (中指尖)
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const middleTip = landmarks[12];

  // 计算三个指尖之间的距离
  const thumbToIndex = getDistance(thumbTip, indexTip);
  const thumbToMiddle = getDistance(thumbTip, middleTip);
  const indexToMiddle = getDistance(indexTip, middleTip);

  // 阈值：当三个指尖距离都小于此值时认为是捏合状态
  const pinchThreshold = 0.08;

  return thumbToIndex < pinchThreshold && thumbToMiddle < pinchThreshold && indexToMiddle < pinchThreshold;
};

// --- Component: 放大照片覆盖层 ---
const PhotoOverlay = ({ photoPath, onClose }: { photoPath: string | null; onClose: () => void }) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (photoPath) {
      // 延迟一帧触发动画
      requestAnimationFrame(() => setIsVisible(true));
    } else {
      setIsVisible(false);
    }
  }, [photoPath]);

  if (!photoPath) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        backgroundColor: isVisible ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        cursor: 'pointer',
        transition: 'background-color 0.4s ease-out',
      }}
    >
      {/* 拍立得边框 */}
      <div
        style={{
          backgroundColor: '#FFFAF0',
          padding: '20px 20px 60px 20px',
          boxShadow: isVisible ? '0 25px 80px rgba(255, 215, 0, 0.3), 0 0 60px rgba(255, 215, 0, 0.2)' : 'none',
          transform: isVisible ? 'scale(1) rotate(0deg)' : 'scale(0.3) rotate(-15deg)',
          opacity: isVisible ? 1 : 0,
          transition: 'all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <img
          src={photoPath}
          alt="Selected memory"
          style={{
            maxWidth: '70vmin',
            maxHeight: '60vmin',
            objectFit: 'contain',
            display: 'block',
          }}
        />
        {/* 拍立得底部文字 */}
        <div
          style={{
            textAlign: 'center',
            marginTop: '15px',
            fontFamily: "'Caveat', cursive, serif",
            fontSize: '18px',
            color: '#333',
            letterSpacing: '1px',
          }}
        >
          ✨ Merry Christmas ✨
        </div>
      </div>

      {/* 提示文字 */}
      <div
        style={{
          position: 'absolute',
          bottom: '40px',
          left: '50%',
          transform: 'translateX(-50%)',
          color: 'rgba(255, 215, 0, 0.6)',
          fontSize: '12px',
          letterSpacing: '3px',
          textTransform: 'uppercase',
          opacity: isVisible ? 1 : 0,
          transition: 'opacity 0.5s ease-out 0.3s',
        }}
      >
        张开手掌关闭 / Click to close
      </div>
    </div>
  );
};

// --- Gesture Controller ---
type GestureControllerProps = {
  onGesture: (state: SceneState) => void;
  onMove: (speed: number) => void;
  onStatus: (status: string) => void;
  onPinch: (isPinching: boolean) => void;
  debugMode: boolean;
  perf: PerfConfig;
};

const GestureController = ({ onGesture, onMove, onStatus, onPinch, debugMode, perf }: GestureControllerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPinchingRef = useRef(false); // 用于防止重复触发

  // 避免 debug/性能参数变化导致整套 AI 重启
  const debugModeRef = useRef(debugMode);
  useEffect(() => {
    debugModeRef.current = debugMode;
  }, [debugMode]);

  const perfRef = useRef(perf);
  useEffect(() => {
    perfRef.current = perf;
  }, [perf]);

  useEffect(() => {
    let gestureRecognizer: GestureRecognizer | null = null;
    let requestRef = 0;
    let stream: MediaStream | null = null;

    let lastInferenceMs = 0;
    let lastVideoWidth = 0;
    let lastVideoHeight = 0;
    let drawingUtils: DrawingUtils | null = null;

    const setup = async () => {
      onStatus("DOWNLOADING AI...");
      try {
        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");

        const createWithDelegate = async (delegate: 'GPU' | 'CPU') => {
          return await GestureRecognizer.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
              delegate,
            },
            runningMode: "VIDEO",
            numHands: 1
          });
        };

        const preferred = perfRef.current.mediapipe.preferredDelegate;
        try {
          gestureRecognizer = await createWithDelegate(preferred);
        } catch (err) {
          if (preferred === 'GPU') {
            onStatus("GPU 不可用，已切换到 CPU 模式");
            gestureRecognizer = await createWithDelegate('CPU');
          } else {
            throw err;
          }
        }

        onStatus("REQUESTING CAMERA...");
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const videoConstraints = perfRef.current.mediapipe.videoConstraints;
          stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play().catch(() => {
              // ignore autoplay edge cases
            });
            onStatus("AI READY: SHOW HAND");
            predictWebcam();
          }
        } else {
            onStatus("ERROR: CAMERA PERMISSION DENIED");
        }
      } catch (err: any) {
        onStatus(`ERROR: ${err.message || 'MODEL FAILED'}`);
      }
    };

    const predictWebcam = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!gestureRecognizer || !video || !canvas) {
        requestRef = requestAnimationFrame(predictWebcam);
        return;
      }

      const nowMs = Date.now();
      const targetFps = perfRef.current.mediapipe.maxFps;
      const intervalMs = targetFps > 0 ? 1000 / targetFps : 1000 / 15;
      const shouldInfer = nowMs - lastInferenceMs >= intervalMs;

      if (video.videoWidth > 0 && shouldInfer) {
        lastInferenceMs = nowMs;
        const results = gestureRecognizer.recognizeForVideo(video, nowMs);

        // 仅在尺寸变化时更新 canvas 分辨率（避免每帧 set width/height）
        if (video.videoWidth !== lastVideoWidth || video.videoHeight !== lastVideoHeight) {
          lastVideoWidth = video.videoWidth;
          lastVideoHeight = video.videoHeight;
          canvas.width = lastVideoWidth;
          canvas.height = lastVideoHeight;
          drawingUtils = null;
        }

        const debug = debugModeRef.current;
        if (debug) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            if (!drawingUtils) drawingUtils = new DrawingUtils(ctx);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (results.landmarks) {
              for (const landmarks of results.landmarks) {
                drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: "#FFD700", lineWidth: 2 });
                drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 1 });
              }
            }
          }
        }

        // 检测手部关键点
        if (results.landmarks && results.landmarks.length > 0) {
          const landmarks = results.landmarks[0];

          // 检测三指捏合
          const isPinching = detectThreeFingerPinch(landmarks);
          if (isPinching && !isPinchingRef.current) {
            // 捏合刚开始
            isPinchingRef.current = true;
            onPinch(true);
            if (debug) onStatus("DETECTED: THREE FINGER PINCH");
          } else if (!isPinching && isPinchingRef.current) {
            // 捏合结束（手张开）
            isPinchingRef.current = false;
            onPinch(false);
          }

          // 原有手势检测
          if (results.gestures.length > 0) {
            const name = results.gestures[0][0].categoryName;
            const score = results.gestures[0][0].score;
            if (score > 0.4 && !isPinching) {
              if (name === "Open_Palm") onGesture("CHAOS");
              if (name === "Closed_Fist") onGesture("FORMED");
              if (debug) onStatus(`DETECTED: ${name}`);
            }
          }

          // 手部位置控制旋转
          const speed = (0.5 - landmarks[0].x) * 0.15;
          onMove(Math.abs(speed) > 0.01 ? speed : 0);
        } else {
          onMove(0);
          if (debug) onStatus("AI READY: NO HAND");
        }
      }

      requestRef = requestAnimationFrame(predictWebcam);
    };
    setup();
    return () => {
      cancelAnimationFrame(requestRef);
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      try {
        gestureRecognizer?.close?.();
      } catch {
        // ignore
      }
      gestureRecognizer = null;
    };
  }, [onGesture, onMove, onStatus, onPinch]);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.6 : 0, position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, right: 0, width: debugMode ? '320px' : '1px', height: debugMode ? 'auto' : '1px', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

// --- App Entry ---
export default function GrandTreeApp() {
  const QUALITY_STORAGE_KEY = 'christmas-tree:quality';
  const detectDefaultQuality = (): QualityPreset => {
    const mem = (navigator as any)?.deviceMemory as number | undefined;
    const cores = navigator.hardwareConcurrency ?? 8;
    if ((typeof mem === 'number' && mem <= 4) || cores <= 4) return 'LOW';
    return 'HIGH';
  };

  const [quality, setQuality] = useState<QualityPreset>(() => {
    try {
      const stored = localStorage.getItem(QUALITY_STORAGE_KEY);
      if (stored === 'HIGH' || stored === 'LOW') return stored;
    } catch {
      // ignore
    }
    try {
      return detectDefaultQuality();
    } catch {
      return 'HIGH';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(QUALITY_STORAGE_KEY, quality);
    } catch {
      // ignore
    }
  }, [quality]);

  const perf = useMemo(() => PERF_PRESETS[quality], [quality]);

  const [sceneState, setSceneState] = useState<SceneState>('CHAOS');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [aiStatus, setAiStatus] = useState("INITIALIZING...");
  const [debugMode, setDebugMode] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  
  // 使用 ref 来跟踪 selectedPhoto，避免 useCallback 依赖变化
  const selectedPhotoRef = useRef(selectedPhoto);
  selectedPhotoRef.current = selectedPhoto;

  // 处理三指捏合 - 使用 useCallback 避免函数引用变化导致 useEffect 重复执行
  const handlePinch = useCallback((isPinching: boolean) => {
    if (isPinching && !selectedPhotoRef.current) {
      // 随机选择一张照片
      const randomIndex = Math.floor(Math.random() * PHOTO_PATHS.body.length);
      setSelectedPhoto(PHOTO_PATHS.body[randomIndex]);
    } else if (!isPinching && selectedPhotoRef.current) {
      // 手张开时关闭照片
      setSelectedPhoto(null);
    }
  }, []);

  // 关闭照片覆盖层
  const closePhotoOverlay = useCallback(() => {
    setSelectedPhoto(null);
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas
          key={quality}
          dpr={perf.graphics.dpr}
          gl={{
            toneMapping: THREE.ReinhardToneMapping,
            antialias: quality === 'HIGH',
            powerPreference: quality === 'LOW' ? 'low-power' : 'high-performance',
          }}
          shadows={quality === 'HIGH'}
        >
            <Experience sceneState={sceneState} rotationSpeed={rotationSpeed} perf={perf} />
        </Canvas>
      </div>
      <GestureController onGesture={setSceneState} onMove={setRotationSpeed} onStatus={setAiStatus} onPinch={handlePinch} debugMode={debugMode} perf={perf} />

      {/* 照片放大覆盖层 */}
      <PhotoOverlay photoPath={selectedPhoto} onClose={closePhotoOverlay} />

      {/* UI - Stats */}
      <div style={{ position: 'absolute', bottom: '30px', left: '40px', color: '#888', zIndex: 10, fontFamily: 'sans-serif', userSelect: 'none' }}>
        <div style={{ marginBottom: '15px' }}>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Memories</p>
          <p style={{ fontSize: '24px', color: '#FFD700', fontWeight: 'bold', margin: 0 }}>
            {perf.counts.ornaments.toLocaleString()} <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>POLAROIDS</span>
          </p>
        </div>
        <div>
          <p style={{ fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '4px' }}>Foliage</p>
          <p style={{ fontSize: '24px', color: '#004225', fontWeight: 'bold', margin: 0 }}>
            {(perf.counts.foliage / 1000).toFixed(0)}K <span style={{ fontSize: '10px', color: '#555', fontWeight: 'normal' }}>EMERALD NEEDLES</span>
          </p>
        </div>
      </div>

      {/* UI - Buttons */}
      <div style={{ position: 'absolute', bottom: '30px', right: '40px', zIndex: 10, display: 'flex', gap: '10px' }}>
        <button
          onClick={() => setQuality((q) => (q === 'HIGH' ? 'LOW' : 'HIGH'))}
          style={{
            padding: '12px 15px',
            backgroundColor: quality === 'LOW' ? '#FFD700' : 'rgba(0,0,0,0.5)',
            border: '1px solid rgba(255, 215, 0, 0.6)',
            color: quality === 'LOW' ? '#000' : '#FFD700',
            fontFamily: 'sans-serif',
            fontSize: '12px',
            fontWeight: 'bold',
            cursor: 'pointer',
            backdropFilter: 'blur(4px)',
          }}
          title="低配模式：降低粒子/特效/分辨率，适合无独显或老电脑"
        >
          {quality === 'LOW' ? '低配模式 ON' : '低配模式 OFF'}
        </button>
        <button onClick={() => setDebugMode(!debugMode)} style={{ padding: '12px 15px', backgroundColor: debugMode ? '#FFD700' : 'rgba(0,0,0,0.5)', border: '1px solid #FFD700', color: debugMode ? '#000' : '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {debugMode ? 'HIDE DEBUG' : '🛠 DEBUG'}
        </button>
        <button onClick={() => setSceneState(s => s === 'CHAOS' ? 'FORMED' : 'CHAOS')} style={{ padding: '12px 30px', backgroundColor: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255, 215, 0, 0.5)', color: '#FFD700', fontFamily: 'serif', fontSize: '14px', fontWeight: 'bold', letterSpacing: '3px', textTransform: 'uppercase', cursor: 'pointer', backdropFilter: 'blur(4px)' }}>
           {sceneState === 'CHAOS' ? 'Assemble Tree' : 'Disperse'}
        </button>
      </div>

      {/* UI - AI Status */}
      <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', color: aiStatus.includes('ERROR') ? '#FF0000' : 'rgba(255, 215, 0, 0.4)', fontSize: '10px', letterSpacing: '2px', zIndex: 10, background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px' }}>
        {aiStatus}
      </div>
    </div>
  );
}