import React, { useState, useMemo, useEffect } from 'react';
import { Clipboard, FileSpreadsheet, Box, Database, BarChart3, Settings2, X, Plus, Monitor, GripHorizontal, Search, DownloadCloud, AlertTriangle, History, Save, FolderDown, Trash2, Link2, Loader2, ChevronUp, ChevronDown, Users, RefreshCw, PackageCheck } from 'lucide-react';
import localforage from 'localforage';
import { db } from './firebase';
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, orderBy, limit } from 'firebase/firestore';

const App = () => {
  useEffect(() => { document.title = "PO 자동 배정 프로그램 - 슬라이서프로"; }, []);

  const [activeTab, setActiveTab] = useState('input'); 
  const [resultSubTab, setResultSubTab] = useState('summary'); 
  
  // ⭐️ 재고 실사 데이터 상태
  const [sapStock, setSapStock] = useState([]);
  const [locStock, setLocStock] = useState([]);
  const [outboundStock, setOutboundStock] = useState([]);
  const [inventoryResults, setInventoryResults] = useState([]);

  // ⭐️ 정보레코드 데이터 상태
  const [infoRecords, setInfoRecords] = useState([]);
  const [infoRecordSearch, setInfoRecordSearch] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  // ⭐️ 정보레코드 파싱 및 로컬 영구 저장 로직
  const parseInfoRecordData = (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (!text) return;

    withLoading(() => {
      const rows = text.split('\n').filter(row => row.trim() !== '');
      const parsed = rows.map(row => {
        const cols = row.split('\t');
        const val = (v) => (v && v.trim() !== '') ? v.trim() : "임시";

        return {
          pn: cleanPN(cols[0]),               
          rawPn: val(cols[0]),                
          supplierPn: val(cols[1]),           
          itemName: val(cols[2]),             
          manufacturer: val(cols[3]),         
          moq: val(cols[4]),                  
          ppq: val(cols[5]),                  
          lastUpdated: new Date().toLocaleString()
        };
      }).filter(p => p.pn !== "임시");

      setInfoRecords(prev => {
        const combined = [...prev];
        parsed.forEach(newItem => {
          const idx = combined.findIndex(item => item.pn === newItem.pn);
          if (idx > -1) combined[idx] = newItem;
          else combined.push(newItem);
        });
        
        // ⭐️ 핵심 픽스: 3만건의 데이터를 파이어베이스 요금 폭탄 없이 쓰기 위해 내 PC 브라우저 DB에 무료로 영구 저장합니다.
        localforage.setItem('po_info_records', combined);
        
        return combined;
      });

      alert(`${parsed.length}건의 데이터가 내 PC에 반영되었습니다.\n안전을 위해 [클라우드로 백업(업로드)] 버튼도 한 번 눌러주세요.`);
    });
  };

  // ⭐️ 클라우드 서버 동기화 (업로드)
  const syncInfoRecordsToFirebase = async () => {
    if (infoRecords.length === 0) return;
    if (!window.confirm(`${infoRecords.length}건의 데이터를 클라우드 서버에 백업(동기화)하시겠습니까?`)) return;

    try {
      setIsSyncing(true);
      const { writeBatch, doc } = await import("firebase/firestore");
      
      const batchSize = 500;
      for (let i = 0; i < infoRecords.length; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = infoRecords.slice(i, i + batchSize);
        chunk.forEach(item => {
          const itemRef = doc(db, 'info_records', item.pn);
          batch.set(itemRef, item);
        });
        await batch.commit();
      }
      alert("정보레코드가 클라우드 서버에 안전하게 업로드되었습니다.");
    } catch (e) {
      console.error(e);
      alert("서버 동기화 중 오류가 발생했습니다.");
    } finally {
      setIsSyncing(false);
    }
  };

  // ⭐️ 신규: 클라우드 서버에서 내려받기 (PC 변경 시 사용)
  const fetchInfoRecordsFromFirebase = async () => {
    if (!window.confirm("클라우드 서버에서 3만 건의 마스터 정보를 내려받으시겠습니까?\n(대용량 통신이 발생하므로 PC를 바꿨거나 처음 세팅할 때만 권장합니다)")) return;
    
    try {
      setIsSyncing(true);
      const { collection, getDocs } = await import("firebase/firestore");
      const querySnapshot = await getDocs(collection(db, 'info_records'));
      const fetched = [];
      querySnapshot.forEach((doc) => { fetched.push(doc.data()); });
      
      if (fetched.length > 0) {
        setInfoRecords(fetched);
        await localforage.setItem('po_info_records', fetched); // 내 PC에도 저장
        alert(`${fetched.toLocaleString()}건의 마스터 정보를 성공적으로 내려받았습니다!`);
      } else {
        alert("서버에 저장된 마스터 정보가 없습니다.");
      }
    } catch (e) {
      console.error(e);
      alert("서버에서 데이터를 불러오지 못했습니다.");
    } finally {
      setIsSyncing(false);
    }
  };
  const [backlogData, setBacklogData] = useState([]);   
  const [distData, setDistData] = useState([]);         
  const [poDistData, setPoDistData] = useState([]); 
  const [receivingData, setReceivingData] = useState([]);
  
  const [appendModal, setAppendModal] = useState({ isOpen: false, type: null, title: '' });
  const [appendInput, setAppendInput] = useState('');

  const [initialDistData, setInitialDistData] = useState([]); 
  const [compareDraft, setCompareDraft] = useState([]); // ⭐️ 픽스: 화이트스크린의 원인이었던 변수 완벽 복구
  const [forcedPOMappings, setForcedPOMappings] = useState([]); 
  const [manualAdjustments, setManualAdjustments] = useState([]); 
  const [confirmedShortages, setConfirmedShortages] = useState(new Set()); 
  
  // ⭐️ 신규: 3가지 디테일 에러 필터링 및 인라인 수기 입력 상태
  const [errorFilters, setErrorFilters] = useState({ shortage: false, distOverRecv: false, allocDiff: false }); 
  const [inlineAdj, setInlineAdj] = useState(null);



  // 서버에서 불러오기 전까지 빈 배열/기본값으로 세팅합니다.
  const [factoryDB, setFactoryDB] = useState([]); 
  const [factories, setFactories] = useState(['화성', '화성(항공)', '파이롯트', '청북', '청주', '경주', '강동', '하네스', '테크', '판매', '자동배정']);
  const [factoryLimits, setFactoryLimits] = useState({});
  const [suppliers, setSuppliers] = useState([]);

  const [results, setResults] = useState([]);            
  const [itemSummary, setItemSummary] = useState([]); 
  const [updatedBacklog, setUpdatedBacklog] = useState([]);
  const [detailResults, setDetailResults] = useState([]);

  const [selectedItem, setSelectedItem] = useState(null); 
  const [reallocatedPNs, setReallocatedPNs] = useState(new Set());
  const [missingDBMapping, setMissingDBMapping] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [newFactoryName, setNewFactoryName] = useState('');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [draggedFactoryIdx, setDraggedFactoryIdx] = useState(null);
  const [draggedSupplierIdx, setDraggedSupplierIdx] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [newHistoryName, setNewHistoryName] = useState('');
  
  const [sortConfig, setSortConfig] = useState({ key: 'reason', direction: 'asc' });
  const [sortConfigDetail, setSortConfigDetail] = useState({ key: 'partNumber', direction: 'asc' });
  const [sortConfigBacklog, setSortConfigBacklog] = useState({ key: 'partNumber', direction: 'asc' });
  const [sortConfigFactory, setSortConfigFactory] = useState({ key: 'countryVehicle', direction: 'asc' });
  const [sortConfigRecv, setSortConfigRecv] = useState({ key: null, direction: 'asc' });
  const [sortConfigBacklogInput, setSortConfigBacklogInput] = useState({ key: null, direction: 'asc' });
  const [sortConfigDist, setSortConfigDist] = useState({ key: null, direction: 'asc' });
  const [sortConfigPoDist, setSortConfigPoDist] = useState({ key: null, direction: 'asc' });
  
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [inputSearchInput, setInputSearchInput] = useState('');
  const [inputSearchQuery, setInputSearchQuery] = useState('');
  const [showAppendedOnly, setShowAppendedOnly] = useState(false); 


  // ⭐️ 하이브리드 설정 저장: 사내망 차단 대비 로컬과 클라우드 동시 저장
  useEffect(() => { 
    if (factoryDB.length === 0 && suppliers.length === 0) return; 

    const saveSettings = async () => {
      // 1. 사내망에서도 완벽 작동하도록 로컬 스토리지에 즉시 저장
      localStorage.setItem('po_factory_db_final', JSON.stringify(factoryDB));
      localStorage.setItem('po_factory_priority_final', JSON.stringify(factories));
      localStorage.setItem('po_suppliers_v9', JSON.stringify(suppliers));

      // 2. 클라우드 연동 시도 (실패해도 에러 없이 조용히 넘어감)
      try {
        await setDoc(doc(db, 'po_system', 'settings'), { factoryDB, factories, suppliers });
      } catch (error) {
        console.log("사내망 차단: 클라우드 동기화 보류 (로컬에는 안전하게 저장됨)");
      }
    };
    
    const timer = setTimeout(() => saveSettings(), 1500); 
    return () => clearTimeout(timer);
  }, [factories, factoryDB, suppliers]);
  
  useEffect(() => { setCompareDraft(JSON.parse(JSON.stringify(distData))); }, [distData]); // distData 동기화

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = setTimeout(() => setInputSearchQuery(inputSearchInput), 250);
    return () => clearTimeout(timer);
  }, [inputSearchInput]);

  // ⭐️ 하이브리드 데이터 로드: 클라우드 실패 시 1초 만에 로컬 데이터로 자동 복구
  useEffect(() => { 
    const loadData = async () => {
      // ⭐️ 픽스: 앱이 켜지자마자 내 PC에 저장해 둔 3만 건의 마스터 정보를 즉시 복구합니다.
      try {
        const storedRecords = await localforage.getItem('po_info_records');
        if (storedRecords && Array.isArray(storedRecords)) setInfoRecords(storedRecords);
      } catch (err) { console.error("로컬 마스터 정보 로드 실패", err); }

      try {
        setIsLoading(true);

        const fetchWithTimeout = (promise, ms = 3000) => {
            return Promise.race([ promise, new Promise((_, reject) => setTimeout(() => reject(new Error('네트워크 응답 지연')), ms)) ]);
        };
        
        // 1. 클라우드 DB 연결 시도 (3초 타임아웃)
        const settingsRef = doc(db, 'po_system', 'settings');
        const settingsSnap = await fetchWithTimeout(getDoc(settingsRef), 3000);
        
        if (settingsSnap.exists()) {
          const data = settingsSnap.data();
          if (data.factoryDB) setFactoryDB(data.factoryDB);
          if (data.factories) setFactories(data.factories);
          if (data.suppliers) setSuppliers(data.suppliers);
        }

        const q = query(collection(db, 'history'), orderBy('id', 'desc'), limit(20));
        const historySnap = await fetchWithTimeout(getDocs(q), 3000);
        const histData = historySnap.docs.map(doc => doc.data());
        setHistoryList(histData);

      } catch (e) {
        console.log("사내망 차단 감지: 로컬 모드로 전환합니다.", e);
        alert("사내 보안망 차단으로 클라우드에 접속할 수 없습니다.\n내 PC에 저장된 기존 로컬 데이터로 자동 전환합니다.");
        
        // 2. 클라우드 실패 시, 기존에 쓰던 로컬 스토리지에서 데이터 완벽 복구
        try {
          const fDB = localStorage.getItem('po_factory_db_final');
          if (fDB) setFactoryDB(JSON.parse(fDB));

          const fPri = localStorage.getItem('po_factory_priority_final');
          if (fPri) setFactories(JSON.parse(fPri));

          const sup = localStorage.getItem('po_suppliers_v9');
          if (sup) setSuppliers(JSON.parse(sup));

          const localHist = await localforage.getItem('po_auto_assign_history');
          if (localHist && Array.isArray(localHist)) setHistoryList(localHist);
        } catch(localErr) { console.error("로컬 데이터 로드 실패:", localErr); }
        
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  const cleanPN = str => String(str || '').replace(/[\s-]/g, '').toUpperCase();
  
  const parseDateSafe = (dateStr) => {
    if (!dateStr || dateStr === '-') return new Date(9999, 11, 31);
    const m = String(dateStr).match(/(\d{2,4})[-./](\d{1,2})[-./](\d{1,2})/);
    if (m) {
      let y = parseInt(m[1], 10);
      if (y < 100) y += 2000;
      return new Date(y, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }
    return new Date(9999, 11, 31);
  };

  const sortByDueDateAndPO = (a, b) => {
    const dc = (a.dueDate || '').localeCompare(b.dueDate || '');
    if (dc !== 0) return dc;
    return (a.poNo || '').localeCompare(b.poNo || '', undefined, { numeric: true, sensitivity: 'base' });
  };

  const withLoading = fn => { 
    setIsLoading(true); 
    setTimeout(() => { 
      try { 
        fn(); 
      } catch(err) {
        console.error(err);
        alert("데이터 처리 중 오류가 발생했습니다.\n" + err);
      } finally {
        setTimeout(() => setIsLoading(false), 50); 
      }
    }, 50); 
  };

  const clearAll = () => {
    if(window.confirm('현재 작업 중인 데이터를 모두 초기화하시겠습니까?\n(※ 저장된 이력 DB는 유지됩니다)')) {
      withLoading(() => {
        setBacklogData([]); setDistData([]); setReceivingData([]); setPoDistData([]);
        setResults([]); setItemSummary([]); setUpdatedBacklog([]); setDetailResults([]);
        setSelectedItem(null); setReallocatedPNs(new Set());
      });
    }
  };

  const saveCurrentState = async (customName = null, currentData = null) => {
    const nameToSave = customName || newHistoryName;
    if (!nameToSave || !nameToSave.trim()) { alert("저장할 이름을 입력해주세요."); return; }
    
    const dataToSave = currentData || { backlogData, distData, poDistData, receivingData, factoryDB, factories, suppliers, results, itemSummary, updatedBacklog, detailResults };
    
    const newId = Date.now();
    const newEntry = { id: newId, date: new Date().toLocaleString(), name: nameToSave, data: dataToSave };

    // 화면 UI 먼저 업데이트 (반응속도 최적화)
    const updatedHistory = [newEntry, ...historyList].slice(0, 20);
    setHistoryList(updatedHistory);
    setNewHistoryName('');

    try {
      setIsLoading(true);
      
      // 1. 대용량 로컬 DB에 무조건 저장 (사내망 안전 확보)
      await localforage.setItem('po_auto_assign_history', updatedHistory);

      // 2. 클라우드 서버 저장 시도
      const fetchWithTimeout = (promise, ms = 3000) => {
          return Promise.race([ promise, new Promise((_, reject) => setTimeout(() => reject(new Error('네트워크 타임아웃')), ms)) ]);
      };
      await fetchWithTimeout(setDoc(doc(db, 'history', String(newId)), newEntry), 3000);
      
      if (!customName) alert("로컬 및 클라우드 서버에 안전하게 저장되었습니다.");
    } catch (e) {
      console.log("클라우드 저장 차단됨:", e);
      if (!customName) alert("사내망 차단으로 클라우드는 보류되었으나,\n[내 PC 로컬 DB]에는 안전하게 저장되었습니다!");
    } finally {
      setIsLoading(false);
    }
  };

  const autoSaveToHistory = (alertMessage, currentData = null) => {
    const now = new Date();
    const ds = `${now.getMonth()+1}/${now.getDate()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    // saveCurrentState가 async로 바뀌었으므로 그냥 호출만 해둡니다.
    saveCurrentState(`[자동저장] ${ds}`, currentData);
    if(alertMessage) alert(`${alertMessage}\n(데이터가 히스토리에 자동 저장되었습니다)`);
  };

  const loadState = entry => {
    if(window.confirm(`[${entry.name}] 데이터를 불러오시겠습니까?`)) {
      withLoading(() => {
        setBacklogData(entry.data.backlogData || []); setDistData(entry.data.distData || []);
        setPoDistData(entry.data.poDistData || []); setReceivingData(entry.data.receivingData || []);
        setFactoryDB(entry.data.factoryDB || []); 
        setFactories((entry.data.factories || []).map(f => f === '납기대로' ? '자동배정' : f));
        setSuppliers(entry.data.suppliers || []); 
        
        if (entry.data.results && entry.data.itemSummary && entry.data.results.length > 0) {
            setResults(entry.data.results);
            setItemSummary(entry.data.itemSummary);
            setUpdatedBacklog(entry.data.updatedBacklog || []);
            setDetailResults(entry.data.detailResults || []);
            setActiveTab('results');
            setResultSubTab('summary');
        } else {
            setResults([]); setItemSummary([]); setUpdatedBacklog([]); setDetailResults([]);
            setActiveTab('input');
        }
        
        setSelectedItem(null); setReallocatedPNs(new Set()); setShowHistoryModal(false);
      });
    }
  };

  // ⭐️ 하이브리드 삭제: 로컬 즉시 삭제 후 클라우드 동기화
  const deleteState = async id => {
    if(window.confirm("항목을 완전히 삭제하시겠습니까?")) {
      const updatedHistory = historyList.filter(h => h.id !== id);
      setHistoryList(updatedHistory); // 화면 즉시 반영

      try {
        setIsLoading(true);
        // 1. 로컬 DB에서 삭제
        await localforage.setItem('po_auto_assign_history', updatedHistory);

        // 2. 클라우드에서 삭제 시도
        const fetchWithTimeout = (promise, ms = 3000) => {
            return Promise.race([ promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms)) ]);
        };
        await fetchWithTimeout(deleteDoc(doc(db, 'history', String(id))), 3000);

      } catch (e) {
        console.log("클라우드 삭제 지연됨 (로컬은 삭제 완료)");
      } finally {
        setIsLoading(false);
      }
    }
  };

  const addFactory = () => { if (!newFactoryName || factories.includes(newFactoryName)) return; setFactories([...factories, newFactoryName]); setNewFactoryName(''); };
  const removeFactory = name => { if (name === '자동배정' || name === '판매') return; setFactories(factories.filter(f => f !== name)); };
  const handleDragStart = (e, idx) => { setDraggedFactoryIdx(idx); e.dataTransfer.effectAllowed = "move"; };
  const handleDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const handleDrop = (e, dropIndex) => {
    e.preventDefault(); if (draggedFactoryIdx === null || draggedFactoryIdx === dropIndex) return;
    const newFactories = [...factories]; const draggedItem = newFactories.splice(draggedFactoryIdx, 1)[0];
    newFactories.splice(dropIndex, 0, draggedItem); setFactories(newFactories); setDraggedFactoryIdx(null);
  };

  const addSupplier = () => { 
    if (!newSupplierName || suppliers.find(s => s.name === newSupplierName)) return; 
    setSuppliers([...suppliers, { id: Date.now(), name: newSupplierName, dPlus: '', isCurrentMonthOnly: false, isExcluded: false }]); 
    setNewSupplierName(''); 
  };
  const removeSupplier = id => setSuppliers(suppliers.filter(s => s.id !== id));
  const updateSupplierDPlus = (id, val) => setSuppliers(suppliers.map(s => s.id === id ? { ...s, dPlus: val } : s));
  const toggleSupplierCurrentMonth = (id, val) => setSuppliers(suppliers.map(s => s.id === id ? { ...s, isCurrentMonthOnly: val } : s));
  const toggleSupplierExclude = (id, val) => setSuppliers(suppliers.map(s => s.id === id ? { ...s, isExcluded: val } : s));
  const handleSupplierDragStart = (e, idx) => { setDraggedSupplierIdx(idx); e.dataTransfer.effectAllowed = "move"; };
  const handleSupplierDrop = (e, dropIndex) => {
    e.preventDefault(); if (draggedSupplierIdx === null || draggedSupplierIdx === dropIndex) return;
    const newSuppliers = [...suppliers]; const draggedItem = newSuppliers.splice(draggedSupplierIdx, 1)[0];
    newSuppliers.splice(dropIndex, 0, draggedItem); setSuppliers(newSuppliers); setDraggedSupplierIdx(null);
  };

  const parseRawText = (text, type, isAppended = false) => {
    const rows = text.split('\n').filter(row => row.trim() !== '');
    return rows.map((row, index) => {
      const cols = row.split('\t');
      if (type === 'fdb') {
        const cv = cols[0]?.trim() || '';
        const existing = factoryDB.find(db => db.countryVehicle === cv);
        return { id: `fdb-${Date.now()}-${index}`, countryVehicle: cv, location: cols[1]?.trim()||'', wmsFactory: cols[2]?.trim()||'', dPlus: existing ? existing.dPlus : '', isCurrentMonthOnly: existing ? existing.isCurrentMonthOnly : false, isExcluded: existing ? existing.isExcluded : false, isCustom: false };
      }
      if (type === 'bl') return { id: `bl-${Date.now()}-${index}`, countryVehicle: cols[0]?.trim()||'', supplier: cols[1]?.trim()||'', partNumber: cols[2]?.trim()||'', supplierPN: cols[3]?.trim()||'', poNo: cols[4]?.trim()||'', poItem: cols[5]?.trim()||'', dueDate: cols[6]?.trim()||'', orderQty: parseInt(cols[7]?.replace(/,/g, ''))||0, deliveredQty: parseInt(cols[8]?.replace(/,/g, ''))||0, pendingQty: parseInt(cols[9]?.replace(/,/g, ''))||0, availableStock: cols[10]?.trim()||'0', allocatedDist: 0, allocatedAuto: 0, allocatedPo: 0, allocated: 0, allocatedWarehouse: 0 };
      if (type === 'dist') {
        const factoryAllocations = {}; 
        factories.forEach((name, i) => { factoryAllocations[name] = parseInt(cols[3+i]?.replace(/,/g, ''))||0; });
        const totalQty = parseInt(cols[2]?.replace(/,/g, ''))||0; 
        const sumInRow = Object.values(factoryAllocations).reduce((a, b) => a + b, 0);
        const pastedAutoStock = parseInt(cols[3 + factories.length]?.replace(/,/g, ''));
        return { id: `dist-${Date.now()}-${index}`, pn: cols[0]?.trim()||'', supplierPN: cols[1]?.trim()||'', totalQty, factoryAllocations, warehouseStock: !isNaN(pastedAutoStock) ? pastedAutoStock : (totalQty - sumInRow), isAppended };
      }
      if (type === 'poDist') return { id: `podist-${Date.now()}-${index}`, yuraPN: cols[0]?.trim()||'', poNo: cols[1]?.trim()||'', poItem: cols[2]?.trim()||'', qty: parseInt(cols[3]?.replace(/,/g, ''))||0 };
      if (type === 'recv') return { id: `recv-${Date.now()}-${index}`, yuraPN: cols[0]?.trim()||'', qty: (cols.length >= 3) ? parseInt(cols[2]?.replace(/,/g, '')) : parseInt(cols[1]?.replace(/,/g, ''))||0, isAppended };
      return null;
    }).filter(Boolean);
  };

  const parseData = (e, type) => {
    e.preventDefault(); 
    const text = e.clipboardData.getData('text'); 
    if (!text) return;

    if (type === 'fdb' && factoryDB.length > 0) {
      if (!window.confirm('매칭 DB를 덮어쓰시겠습니까? 기존 D+ 및 당월 설정은 유지됩니다.')) return;
    }

    withLoading(() => {
      try {
        const parsed = parseRawText(text, type, false);
        if (type === 'fdb') setFactoryDB(parsed);
        else if (type === 'bl') setBacklogData(parsed);
        else if (type === 'dist') setDistData(parsed);
        else if (type === 'poDist') setPoDistData(parsed);
        else if (type === 'recv') setReceivingData(parsed);
      } catch (err) { alert("데이터 변환 오류."); }
    });
  };
  
// ⭐️ 재고 실사 데이터 파싱 (하이픈 유지 로직 반영)
  const parseInventoryData = (e, type) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (!text) return;

    withLoading(() => {
      const rows = text.split('\n').filter(row => row.trim() !== '');
      const parsed = rows.map((row) => {
        const cols = row.split('\t');
        const rawPn = cols[type === 'loc' || type === 'out' ? 1 : 0]?.trim() || '';
        const qtyIndex = type === 'loc' ? 2 : (type === 'out' ? 2 : 1);
        
        return { 
          rawPn: rawPn, // ⭐️ 원본 하이픈 유지용
          pn: cleanPN(rawPn), // ⭐️ 비교 매칭용
          qty: parseInt(cols[qtyIndex]?.replace(/,/g, '')) || 0,
          loc: type === 'loc' ? cols[0]?.trim() : null,
          factory: type === 'out' ? cols[0]?.trim() : null
        };
      }).filter(Boolean);

      if (type === 'sap') setSapStock(parsed);
      else if (type === 'loc') setLocStock(parsed);
      else if (type === 'out') setOutboundStock(parsed);
    });
  };

  // ⭐️ 재고 실사 관련 상태 확장
  const [inventorySubTab, setInventorySubTab] = useState('summary'); // 'summary' 또는 'location'
  const [inventoryResults, setInventoryResults] = useState([]); // 품번별 요약
  const [inventoryLocResults, setInventoryLocResults] = useState([]); // 로케이션별 상세

  // ⭐️ 재고 실사 실행 로직 (요약 및 로케이션별 상세 동시 산출)
  const runInventoryAudit = () => {
    if (sapStock.length === 0 && locStock.length === 0) {
      alert("SAP 재고 또는 로케이션 재고 데이터를 먼저 입력해주세요.");
      return;
    }

    withLoading(() => {
      // 1. 모든 고유 품번 추출
      const allPNs = [...new Set([...sapStock.map(s => s.pn), ...locStock.map(l => l.pn)])];

      // 2. 품번별 요약 리포트 생성 (Summary)
      const summaryReport = allPNs.map(pn => {
        const sampleSap = sapStock.find(s => s.pn === pn);
        const sampleLoc = locStock.find(l => l.pn === pn);
        const displayPn = sampleSap?.rawPn || sampleLoc?.rawPn || pn;
        const masterInfo = infoRecords.find(info => info.pn === pn);

        const sapQty = sapStock.filter(s => s.pn === pn).reduce((acc, curr) => acc + curr.qty, 0);
        const locQty = locStock.filter(l => l.pn === pn).reduce((acc, curr) => acc + curr.qty, 0);
        const outItems = outboundStock.filter(o => o.pn === pn);
        const outQty = outItems.reduce((acc, curr) => acc + curr.qty, 0);
        const diff = locQty - sapQty;

        const remark = outItems.length > 0 
          ? outItems.map(o => `[${o.factory}] 출고대기 (${o.qty.toLocaleString()}개)`).join(' / ')
          : '-';

        return {
          itemName: masterInfo?.itemName || "임시",
          manufacturer: masterInfo?.manufacturer || "임시",
          rawPn: displayPn,
          supplierPn: masterInfo?.supplierPn || "임시",
          sapQty, locQty, outQty, diff, remark
        };
      });

      // 3. 로케이션별 상세 리포트 생성 (Location Detail)
      const locationReport = [];
      allPNs.forEach(pn => {
        const masterInfo = infoRecords.find(info => info.pn === pn);
        const sapTotalQty = sapStock.filter(s => s.pn === pn).reduce((acc, curr) => acc + curr.qty, 0);
        const pnLocItems = locStock.filter(l => l.pn === pn);
        const totalLocQty = pnLocItems.reduce((acc, curr) => acc + curr.qty, 0);
        const totalDiff = totalLocQty - sapTotalQty;
        
        const outItems = outboundStock.filter(o => o.pn === pn);
        const remark = outItems.length > 0 
          ? outItems.map(o => `[${o.factory}] 출고대기 (${o.qty.toLocaleString()}개)`).join(' / ')
          : '-';

        // 해당 품번이 로케이션 데이터에 있는 경우 각 로케이션별로 행 생성
        if (pnLocItems.length > 0) {
          pnLocItems.forEach(locItem => {
            locationReport.push({
              loc: locItem.loc || "위치미지정",
              itemName: masterInfo?.itemName || "임시",
              manufacturer: masterInfo?.manufacturer || "임시",
              rawPn: locItem.rawPn,
              supplierPn: masterInfo?.supplierPn || "임시",
              locQty: locItem.qty,
              sapTotalQty: sapTotalQty, // 비교를 위한 품번별 총 SAP 재고
              totalDiff: totalDiff,     // 품번별 총 차이
              remark: remark
            });
          });
        } else {
          // SAP에는 있으나 로케이션에는 없는 경우 (실물 실종)
          const sampleSap = sapStock.find(s => s.pn === pn);
          locationReport.push({
            loc: "실물 없음",
            itemName: masterInfo?.itemName || "임시",
            manufacturer: masterInfo?.manufacturer || "임시",
            rawPn: sampleSap.rawPn,
            supplierPn: masterInfo?.supplierPn || "임시",
            locQty: 0,
            sapTotalQty: sapTotalQty,
            totalDiff: -sapTotalQty,
            remark: remark
          });
        }
      });

      setInventoryResults(summaryReport);
      setInventoryLocResults(locationReport.sort((a, b) => a.loc.localeCompare(b.loc)));
      setInventorySubTab('summary'); // 실행 후 기본은 요약 탭으로
    });
  };

  const handleAppendSave = () => {
      if(!appendInput.trim()) return;
      withLoading(() => {
          try {
              const parsed = parseRawText(appendInput, appendModal.type, true);
              if (appendModal.type === 'recv') setReceivingData(prev => [...prev, ...parsed]);
              else if (appendModal.type === 'dist') setDistData(prev => [...prev, ...parsed]);
              
              setAppendModal({ isOpen: false, type: null, title: '' });
              setAppendInput('');
          } catch(err) {
              alert("추가 데이터 변환 중 오류가 발생했습니다.");
          }
      });
  };

  const runAllocationLogic = (currentBacklog, currentDist, currentPoDist, currentRecv, currentFactories, currentDB, currentSuppliers, currentConfirmed, currentManualAdj) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const endOfCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);

    const isWithinLimits = (target) => {
      const targetDate = parseDateSafe(target.dueDate);
      let fCut = new Date(9999, 11, 31); let sCut = new Date(9999, 11, 31);
      const mFDB = currentDB.find(db => db.countryVehicle === target.countryVehicle);
      if (mFDB) {
        if (mFDB.isExcluded) return false; 
        if (mFDB.dPlus) { fCut = new Date(today); fCut.setDate(fCut.getDate() + parseInt(mFDB.dPlus, 10)); }
        if (mFDB.isCurrentMonthOnly && targetDate > endOfCurrentMonth) return false; 
      }
      const mSup = currentSuppliers.find(s => s.name === target.supplier);
      if (mSup) {
        if (mSup.isExcluded) return false; 
        if (mSup.dPlus) { sCut = new Date(today); sCut.setDate(sCut.getDate() + parseInt(mSup.dPlus, 10)); }
        if (mSup.isCurrentMonthOnly && targetDate > endOfCurrentMonth) return false; 
      }
      return targetDate <= fCut && targetDate <= sCut;
    };

    let workingBacklog = currentBacklog.map(b => {
      const mDB = currentDB.find(db => db.countryVehicle === b.countryVehicle);
      return { ...b, computedFactory: mDB?.wmsFactory || '미매칭', dbLocation: mDB?.location || '미매칭', allocatedDist: 0, allocatedAuto: 0, allocatedAutoDist: 0, allocatedAutoRecv: 0, allocatedPo: 0, allocatedWarehouse: 0, allocated: 0, _cleanPN: cleanPN(b.partNumber), isAppendedDist: false, isAppendedRecv: false, isAirDist: false };
    });

    const workingBacklogByPN = {};
    workingBacklog.forEach(b => {
        if (!workingBacklogByPN[b._cleanPN]) workingBacklogByPN[b._cleanPN] = [];
        workingBacklogByPN[b._cleanPN].push(b);
    });
    
    if (currentPoDist && currentPoDist.length > 0) {
      currentPoDist.forEach(pDist => {
        let currentQty = pDist.qty; if (currentQty <= 0) return;
        const targets = (workingBacklogByPN[cleanPN(pDist.yuraPN)] || [])
            .filter(b => cleanPN(b.poNo) === cleanPN(pDist.poNo) && cleanPN(b.poItem) === cleanPN(pDist.poItem))
            .sort(sortByDueDateAndPO);

        targets.forEach(target => {
          if (currentQty <= 0) return;
          const remaining = target.pendingQty - (target.allocatedDist + target.allocatedAuto + target.allocatedPo);
          if (remaining <= 0) return;
          const allocation = Math.min(remaining, currentQty);
          target.allocatedPo += allocation; currentQty -= allocation;
          if (pDist.targetFactory) target.computedFactory = pDist.targetFactory; 
        });
      });
    }

    if (currentDist.length > 0) {
      currentDist.forEach(dist => {
        const dPN = cleanPN(dist.pn);
        if (!workingBacklogByPN[dPN]) workingBacklogByPN[dPN] = [];
        const pnBacklogs = workingBacklogByPN[dPN];

        // ⭐️ 강제로 이관된 '창고재고' 및 '판매재고'를 가짜 PO 형태로 안전하게 주입
        const resolvedSupPN = currentBacklog.find(b => cleanPN(b.partNumber) === dPN)?.supplierPN || dist.supplierPN || '-';
        if (dist.warehouseStock > 0) {
            const dummyWH = { id: `dummy-wh-${Date.now()}-${Math.random()}`, countryVehicle: '창고재고', supplier: '-', dbLocation: '창고재고', computedFactory: '창고재고', partNumber: dist.pn, supplierPN: resolvedSupPN, _cleanPN: dPN, poNo: 'PO 없음(수동이관)', poItem: '-', dueDate: '-', orderQty: 0, deliveredQty: 0, pendingQty: 0, availableStock: '-', allocatedDist: 0, allocatedAuto: 0, allocatedAutoDist: 0, allocatedAutoRecv: 0, allocatedPo: 0, allocatedWarehouse: dist.warehouseStock, allocated: 0, isAppendedDist: dist.isAppended, isAirDist: false };
            workingBacklog.push(dummyWH); pnBacklogs.push(dummyWH);
        }
        if (dist.salesStock > 0) {
            const dummySales = { id: `dummy-sales-${Date.now()}-${Math.random()}`, countryVehicle: '판매재고', supplier: '-', dbLocation: '판매', computedFactory: '판매재고', partNumber: dist.pn, supplierPN: resolvedSupPN, _cleanPN: dPN, poNo: 'PO 없음(판매)', poItem: '-', dueDate: '-', orderQty: 0, deliveredQty: 0, pendingQty: 0, availableStock: '-', allocatedDist: 0, allocatedAuto: 0, allocatedAutoDist: 0, allocatedAutoRecv: 0, allocatedPo: 0, allocatedWarehouse: dist.salesStock, allocated: 0, isAppendedDist: dist.isAppended, isAirDist: false };
            workingBacklog.push(dummySales); pnBacklogs.push(dummySales);
        }

        Object.keys(dist.factoryAllocations).forEach(factoryName => {
          if (factoryName === '자동배정' || factoryName === '납기대로') return;
          let currentQty = dist.factoryAllocations[factoryName];
          if (currentQty > 0) {
            
            const forcedForThisFactory = (currentPoDist || [])
                .filter(p => cleanPN(p.yuraPN) === dPN && p.targetFactory === factoryName)
                .reduce((s, p) => s + p.qty, 0);
            
            currentQty -= forcedForThisFactory;
            if (currentQty < 0) currentQty = 0;

            if (currentQty > 0) {
                if (factoryName === '화성(항공)') {
                    let targets = pnBacklogs.filter(b => b.computedFactory.includes('강동'));
                    targets.sort((a, b) => {
                        const aIsAir = String(a.countryVehicle || '').includes('항공') || String(a.dbLocation || '').includes('항공');
                        const bIsAir = String(b.countryVehicle || '').includes('항공') || String(b.dbLocation || '').includes('항공');
                        if (aIsAir && !bIsAir) return -1;
                        if (!aIsAir && bIsAir) return 1;
                        return sortByDueDateAndPO(a, b);
                    });

                    targets.forEach(target => {
                      if (currentQty <= 0) return;
                      const remaining = target.pendingQty - (target.allocatedDist + target.allocatedAuto + target.allocatedPo);
                      if (remaining <= 0) return;
                      const allocation = Math.min(remaining, currentQty);
                      
                      const clonedRow = {
                          ...target, id: `split-${target.id}-${Date.now()}-${Math.random()}`,
                          computedFactory: '유라코퍼레이션-화성', dbLocation: '화성',
                          pendingQty: allocation, orderQty: allocation, allocatedDist: allocation, allocatedAuto: 0, allocatedAutoDist: 0, allocatedAutoRecv: 0, allocatedPo: 0, allocatedWarehouse: 0, allocated: allocation,
                          isAppendedDist: dist.isAppended, isAirDist: true 
                      };

                      target.pendingQty -= allocation;
                      if (target.orderQty >= allocation) target.orderQty -= allocation; else target.orderQty = 0;

                      workingBacklog.push(clonedRow); pnBacklogs.push(clonedRow);
                      currentQty -= allocation;
                    });
                } else {
                    const searchKey = factoryName === '화성(항공)' ? '유라코퍼레이션-화성' : factoryName;
                    let targets = pnBacklogs.filter(b => b.computedFactory.includes(searchKey)).sort(sortByDueDateAndPO);
                    targets.forEach(target => {
                      if (currentQty <= 0) return;
                      const remaining = target.pendingQty - (target.allocatedDist + target.allocatedAuto + target.allocatedPo);
                      if (remaining <= 0) return;
                      const allocation = Math.min(remaining, currentQty);
                      target.allocatedDist += allocation; currentQty -= allocation;
                      if (dist.isAppended) target.isAppendedDist = true;
                    });
                }

                if (currentQty > 0) {
                   const resolvedSupPN = currentBacklog.find(b => cleanPN(b.partNumber) === dPN)?.supplierPN || dist.supplierPN || '-';
                   const isConfirmed = currentConfirmed && currentConfirmed.has(`${dPN}_${factoryName}`);
                   
                   let finalComputed = isConfirmed ? '창고재고' : '미배정(지시초과)';
                   let finalPoNo = isConfirmed ? 'PO 없음(창고이관)' : 'PO 없음(지시초과)';
                   let finalLoc = isConfirmed ? '창고재고' : '미배정';
                   let finalCV = isConfirmed ? '창고재고' : '미배정(지시초과)';
                   let finalAllocWh = isConfirmed ? currentQty : 0;
                   
                   // ⭐️ 버그 픽스 핵심: 미배정(에러) 상태로 빠진 초과 수량도 내부적으로는 '할당됨(allocated)'으로 묶어두어, 이후의 자동 배정 로직이 훔쳐가지 못하게 잠급니다.
                   let finalAllocDist = isConfirmed ? 0 : currentQty; 

                   if (factoryName === '판매') {
                       finalComputed = '판매';
                       finalPoNo = 'PO 없음';
                       finalLoc = '판매';
                       finalCV = '판매';
                       finalAllocWh = 0;
                       finalAllocDist = currentQty; 
                   }

                   const dummyMissingPO = { 
                       id: `dummy-miss-${Date.now()}-${Math.random()}`, 
                       countryVehicle: finalCV, supplier: '-', dbLocation: finalLoc, computedFactory: finalComputed, 
                       partNumber: dist.pn, supplierPN: resolvedSupPN, _cleanPN: dPN, 
                       poNo: finalPoNo, poItem: '-', dueDate: '-', orderQty: 0, deliveredQty: 0, pendingQty: 0, availableStock: '-', 
                       allocatedDist: finalAllocDist, allocatedAuto: 0, allocatedAutoDist: 0, allocatedAutoRecv: 0, allocatedPo: 0, 
                       allocatedWarehouse: finalAllocWh, 
                       allocated: finalAllocDist + finalAllocWh, isAppendedDist: dist.isAppended, isAirDist: false
                   };
                   workingBacklog.push(dummyMissingPO); pnBacklogs.push(dummyMissingPO);
                }
            }
          }
        });
        
        let globalQty = (dist.factoryAllocations['자동배정'] || dist.factoryAllocations['납기대로'] || 0);
        if (globalQty > 0) {
          // ⭐️ 변경 1: 자동배정 시 무조건 배정하지 않고, 납기/출고 통제(isWithinLimits)를 통과한 유효 PO만 걸러냅니다.
          let targets = [...pnBacklogs].filter(t => isWithinLimits(t)).sort(sortByDueDateAndPO);
          
          targets.forEach(target => {
            if (globalQty <= 0) return;
            const remaining = target.pendingQty - (target.allocatedDist + target.allocatedAuto + target.allocatedPo);
            if (remaining <= 0) return;
            const allocation = Math.min(remaining, globalQty);
            target.allocatedAuto += allocation; 
            target.allocatedAutoDist += allocation;
            if(dist.isAppended) target.isAppendedDist = true; 
            globalQty -= allocation; 
          });

          // ⭐️ 변경 2: 납기 통제에 막혀 배정되지 못한 자동배정 잔량 처리 (창고로 가지 않고 에러로 잡아냅니다)
          if (globalQty > 0) {
               const resolvedSupPN = currentBacklog.find(b => cleanPN(b.partNumber) === dPN)?.supplierPN || dist.supplierPN || '-';
               const dummyMissingPO = { 
                   id: `dummy-miss-auto-${Date.now()}-${Math.random()}`, 
                   countryVehicle: '미배정(지시초과)', 
                   supplier: '-', 
                   dbLocation: '미배정', 
                   computedFactory: '미배정(지시초과)', 
                   partNumber: dist.pn, supplierPN: resolvedSupPN, _cleanPN: dPN, 
                   poNo: 'PO 없음(자동납기제한)', 
                   poItem: '-', dueDate: '-', orderQty: 0, deliveredQty: 0, pendingQty: 0, availableStock: '-', 
                   allocatedDist: 0, allocatedAuto: globalQty, allocatedAutoDist: globalQty, allocatedAutoRecv: 0, allocatedPo: 0, 
                   allocatedWarehouse: 0, 
                   allocated: globalQty, isAppendedDist: dist.isAppended, isAirDist: false
               };
               workingBacklog.push(dummyMissingPO); pnBacklogs.push(dummyMissingPO);
          }
        }
      });
    }

    const receivingWithCleanPN = currentRecv.map(r => ({ ...r, _cleanPN: cleanPN(r.yuraPN) }));
    if (receivingWithCleanPN.length > 0) {
      const uniquePNs = [...new Set(receivingWithCleanPN.map(r => r._cleanPN))];
      uniquePNs.forEach(pnKey => {
        const pnBacklogs = workingBacklogByPN[pnKey] || [];
        const totalReceived = receivingWithCleanPN.filter(r => r._cleanPN === pnKey).reduce((acc, curr) => acc + curr.qty, 0);
        const hasAppendedRecv = receivingWithCleanPN.filter(r => r._cleanPN === pnKey).some(r => r.isAppended);
        
        const totalDistAllocated = pnBacklogs.reduce((acc, curr) => acc + curr.allocatedDist + curr.allocatedPo + curr.allocatedAuto + curr.allocatedWarehouse, 0);
        let availableAutoQty = totalReceived - totalDistAllocated;
        
        if (availableAutoQty > 0) {
          let targets = pnBacklogs.filter(b => b.pendingQty > (b.allocatedDist + b.allocatedAuto + b.allocatedPo));
          targets = targets.filter(target => isWithinLimits(target)).sort(sortByDueDateAndPO);
          targets.forEach(target => {
              if (availableAutoQty <= 0) return;
              let needed = target.pendingQty - (target.allocatedDist + target.allocatedAuto + target.allocatedPo);
              let actual = Math.min(availableAutoQty, needed);
              target.allocatedAuto += actual; 
              target.allocatedAutoRecv += actual;
              availableAutoQty -= actual;
              if(hasAppendedRecv) target.isAppendedRecv = true;
          });
          
          if (availableAutoQty > 0) {
              const originalPN = receivingWithCleanPN.find(r => r._cleanPN === pnKey).yuraPN;
              const resolvedSupPN = currentBacklog.find(b => cleanPN(b.partNumber) === pnKey)?.supplierPN || currentDist.find(d => cleanPN(d.pn) === pnKey)?.supplierPN || '-';
              workingBacklog.push({
                  id: `dummy-recv-${Date.now()}-${Math.random()}`, countryVehicle: '창고재고', supplier: '-', dbLocation: '창고재고', computedFactory: '창고재고', 
                  partNumber: originalPN, supplierPN: resolvedSupPN, _cleanPN: pnKey, poNo: 'PO 없음', poItem: '-', dueDate: '-', 
                  orderQty: 0, deliveredQty: 0, pendingQty: 0, availableStock: '-', 
                  allocatedDist: 0, allocatedAuto: 0, allocatedAutoDist: 0, allocatedAutoRecv: 0, allocatedPo: 0, allocatedWarehouse: availableAutoQty, allocated: 0,
                  isAppended: hasAppendedRecv 
              });
          }
        }
      });
    }

    workingBacklog = workingBacklog.map(b => ({ ...b, allocated: b.allocatedDist + b.allocatedAuto + b.allocatedPo }));

    if (currentManualAdj && currentManualAdj.length > 0) {
        currentManualAdj.forEach(adj => {
            const targetPO = workingBacklog.find(b => b._cleanPN === cleanPN(adj.pn) && b.poNo === adj.poNo && b.poItem === adj.poItem && b.computedFactory === adj.factory);
            if (targetPO) {
                if (adj.delta > 0) { 
                    const whs = workingBacklog.filter(b => b._cleanPN === cleanPN(adj.pn) && (b.computedFactory === '창고재고' || b.computedFactory === '미배정(지시초과)'));
                    let remainingDelta = adj.delta;
                    whs.forEach(wh => {
                        if (remainingDelta > 0 && (wh.allocatedWarehouse || 0) > 0) {
                            const move = Math.min(wh.allocatedWarehouse, remainingDelta);
                            wh.allocatedWarehouse -= move;
                            targetPO.allocatedPo += move; 
                            targetPO.allocated += move; 
                            remainingDelta -= move;
                        }
                    });
                } else if (adj.delta < 0) { 
                    let remainingDelta = Math.abs(adj.delta);
                    if (remainingDelta > 0 && targetPO.allocatedPo > 0) { const move = Math.min(targetPO.allocatedPo, remainingDelta); targetPO.allocatedPo -= move; targetPO.allocated -= move; remainingDelta -= move; }
                    if (remainingDelta > 0 && targetPO.allocatedDist > 0) { const move = Math.min(targetPO.allocatedDist, remainingDelta); targetPO.allocatedDist -= move; targetPO.allocated -= move; remainingDelta -= move; }
                    if (remainingDelta > 0 && targetPO.allocatedAuto > 0) { const move = Math.min(targetPO.allocatedAuto, remainingDelta); targetPO.allocatedAuto -= move; targetPO.allocated -= move; remainingDelta -= move; }
                    
                    const totalMove = Math.abs(adj.delta) - remainingDelta;
                    if (totalMove > 0) {
                        let wh = workingBacklog.find(b => b._cleanPN === cleanPN(adj.pn) && b.computedFactory === '미배정(지시초과)');
                        if (!wh) {
                            wh = { ...targetPO, id: `wh-man-${Date.now()}-${Math.random()}`, computedFactory: '미배정(지시초과)', dbLocation: '미배정', poNo: 'PO 없음(취소반환)', poItem: '-', dueDate: '-', allocatedWarehouse: 0, allocatedDist: 0, allocatedAuto: 0, allocatedPo: 0, allocated: 0 };
                            workingBacklog.push(wh);
                        }
                        wh.allocatedWarehouse = (wh.allocatedWarehouse || 0) + totalMove;
                    }
                }
            }
        });
    }
    
    const allUniquePNs = new Set([...currentBacklog.map(b => cleanPN(b.partNumber)), ...currentDist.map(d => cleanPN(d.pn)), ...receivingWithCleanPN.map(r => r._cleanPN)]);
    
    const backlogByPN = {}; currentBacklog.forEach(b => { const pn = cleanPN(b.partNumber); if (!backlogByPN[pn]) backlogByPN[pn] = []; backlogByPN[pn].push(b); });
    const distByPN = {}; currentDist.forEach(d => { const pn = cleanPN(d.pn); if (!distByPN[pn]) distByPN[pn] = []; distByPN[pn].push(d); });
    const recvByPN = {}; receivingWithCleanPN.forEach(r => { const pn = r._cleanPN; if (!recvByPN[pn]) recvByPN[pn] = []; recvByPN[pn].push(r); });
    const resByPN = {}; workingBacklog.forEach(b => { const pn = b._cleanPN; if (!resByPN[pn]) resByPN[pn] = []; resByPN[pn].push(b); });

    const summaryData = Array.from(allUniquePNs).map(pnKey => {
      const bItems = backlogByPN[pnKey] || []; const dItems = distByPN[pnKey] || []; const resItems = resByPN[pnKey] || []; const rItems = recvByPN[pnKey] || [];
      const originalPn = bItems[0]?.partNumber || dItems[0]?.pn || resItems[0]?.partNumber || pnKey;
      const originalSupPN = bItems[0]?.supplierPN || dItems[0]?.supplierPN || resItems[0]?.supplierPN || '-';
      const hasAppendedItem = dItems.some(d => d.isAppended) || rItems.some(r => r.isAppended) || resItems.some(r => r.isAppendedDist || r.isAppendedRecv);

      const poQty = bItems.reduce((acc, curr) => acc + curr.pendingQty, 0);
      const distQty = dItems.reduce((acc, curr) => acc + curr.totalQty, 0); 
      const recvQty = rItems.reduce((acc, curr) => acc + curr.qty, 0);
      const totalAllocQty = resItems.reduce((acc, curr) => acc + curr.allocated, 0);
      
      let pShortages = []; let pSurpluses = [];
      currentFactories.filter(f => f !== '자동배정').forEach(f => {
          const req = dItems.reduce((sum, d) => sum + (d.factoryAllocations[f] || 0), 0);
          const searchKey = f === '화성(항공)' ? '유라코퍼레이션-화성' : f;
          let allocDistLoc = 0;
          
          // ⭐️ 에러 픽스: 0순위로 배정된 PO(allocatedPo) 수량도 합산하여 가짜 부족 오류를 차단합니다!
          if(f === '화성(항공)') allocDistLoc = resItems.filter(r => r.isAirDist === true).reduce((sum, r) => sum + r.allocatedDist + r.allocatedPo, 0);
          else if(f === '화성') allocDistLoc = resItems.filter(r => r.computedFactory.includes('화성') && r.isAirDist !== true).reduce((sum, r) => sum + r.allocatedDist + r.allocatedPo, 0);
          else allocDistLoc = resItems.filter(r => r.computedFactory.includes(searchKey)).reduce((sum, r) => sum + r.allocatedDist + r.allocatedPo, 0);

          if (req > allocDistLoc) pShortages.push({ loc: f, qty: req - allocDistLoc });
      });
      const uniqueLocs = [...new Set(resItems.map(r => r.computedFactory))];
      uniqueLocs.forEach(loc => {
          if (loc === '미매칭' || loc === '창고재고' || loc === '판매' || loc === '판매재고' || loc === '미배정(지시초과)') return;
          const poLoc = resItems.filter(r => r.computedFactory === loc).reduce((sum, r) => sum + r.pendingQty, 0);
          const allocLoc = resItems.filter(r => r.computedFactory === loc).reduce((sum, r) => sum + r.allocated, 0);
          if (poLoc - allocLoc > 0) pSurpluses.push({ loc, qty: poLoc - allocLoc });
      });
      
      // ⭐️ 3종 핵심 에러 판별 로직
      const hasUnallocated = resItems.some(r => r.computedFactory === '창고재고' || r.computedFactory === '미배정(지시초과)');
      const hasShortage = pShortages.length > 0;
      const hasDistOverRecv = distQty > recvQty; 
      const hasAllocDiff = distQty !== totalAllocQty; 

      // ⭐️ 요청사항: 정상 배정 및 발주 잔량 남음 등의 케이스는 라벨 메세지를 지웁니다.
      let reason = ''; 
      
      if (hasShortage) {
          reason = 'PO 부족 (재배정 필요)';
      } else if (hasDistOverRecv) {
          reason = '지시초과'; // '입고 부족' 대신 사용자 요청 단어로 반영
      } else if (distQty > totalAllocQty) {
          reason = '배정 차이 (미배정 발생)';
      } else if (distQty < totalAllocQty) {
          reason = '배정 차이 (초과 배정)'; // 👈 고객님 화면의 AA6TS-00035 품목이 이제 이 에러로 정상 표기됩니다.
      } else if (hasUnallocated) {
          reason = '잔여 입고 (창고재고 이동)';
      }
      
      return { pn: originalPn, supplierPN: originalSupPN, poQty, distQty, recvQty, totalAllocQty, reason, shortages: pShortages, surpluses: pSurpluses, isAppended: hasAppendedItem, hasShortage, hasDistOverRecv, hasAllocDiff };
    });

    const baseSorted = [...workingBacklog].sort((a, b) => cleanPN(a.partNumber).localeCompare(cleanPN(b.partNumber)) || sortByDueDateAndPO(a, b));
    const currentStockMap = {};
    baseSorted.forEach(row => {
        const pn = cleanPN(row.partNumber);
        if (currentStockMap[pn] === undefined) {
            const parsedStock = parseInt(String(row.availableStock).replace(/,/g, ''));
            currentStockMap[pn] = (!isNaN(parsedStock) && parsedStock > 0) ? parsedStock : 0;
        }
    });
    workingBacklog.forEach(r => {
        if (r.computedFactory === '창고재고' || r.computedFactory === '미배정(지시초과)') {
            const pn = cleanPN(r.partNumber);
            if (currentStockMap[pn] !== undefined) currentStockMap[pn] += r.allocatedWarehouse || 0; 
        }
    });

    const newUpdatedBacklog = baseSorted.filter(row => row.computedFactory !== '판매재고').map(row => {
        const pn = cleanPN(row.partNumber);
        if (row.computedFactory === '창고재고' || row.computedFactory === '미배정(지시초과)') return { ...row, newPending: 0, stockApplied: 0 };
        let newPending = row.pendingQty - row.allocated;
        let stockApplied = 0;
        if (newPending > 0 && currentStockMap[pn] > 0) {
            stockApplied = Math.min(newPending, currentStockMap[pn]);
            newPending -= stockApplied; currentStockMap[pn] -= stockApplied;
        }
        return { ...row, newDelivered: row.deliveredQty + row.allocated, newPending, stockApplied };
    });

    return { newResults: workingBacklog, newSummary: summaryData, newUpdatedBacklog };
  };

  const processAllocation = () => {
    if (backlogData.length === 0) { alert("발주 대장 데이터를 입력해주세요."); return; }
    const neededCVs = [...new Set(backlogData.map(b => b.countryVehicle))];
    const missing = [];
    neededCVs.forEach(cv => {
        const dbEntry = factoryDB.find(db => db.countryVehicle === cv);
        if (!dbEntry || !dbEntry.wmsFactory || !dbEntry.wmsFactory.trim()) {
            const bItem = backlogData.find(b => b.countryVehicle === cv);
            missing.push({ countryVehicle: cv, location: dbEntry?.location || bItem?.location || '', wmsFactory: '', dPlus: '', isCurrentMonthOnly: false, isExcluded: false, isCustom: false, isNew: !dbEntry });
        }
    });
    if (missing.length > 0) { setMissingDBMapping(missing); return; }
    executeAllocationWithDist(distData);
  };

  const executeAllocationWithDist = (currentDistArr, currentForcedPOs = forcedPOMappings, currentConfirmed = confirmedShortages, currentManualAdj = manualAdjustments) => {
    setReallocatedPNs(new Set()); 
    const { newResults, newSummary, newUpdatedBacklog } = runAllocationLogic(backlogData, currentDistArr, [...poDistData, ...currentForcedPOs], receivingData, factories, factoryDB, suppliers, currentConfirmed, currentManualAdj);
    
    const newDetailResults = newResults.filter(r => r && r.computedFactory !== '창고재고' && (r.allocated > 0 || r.allocatedWarehouse > 0 || String(r.poNo).includes('PO 없음')));

    const newCompareDraft = currentDistArr.map(d => {
        const dPN = cleanPN(d.pn);
        const rItems = newResults.filter(r => r._cleanPN === dPN && !String(r.poNo).includes('PO 없음'));
        const allocations = {};
        let sum = 0;
        factories.forEach(f => {
            let fAlloc = 0;
            if (f === '자동배정' || f === '납기대로') {
                fAlloc = rItems.reduce((s, r) => s + (r.allocatedAutoDist || 0), 0);
            } else if (f === '화성(항공)') {
                fAlloc = rItems.filter(r => r.isAirDist).reduce((s, r) => s + r.allocatedDist + r.allocatedPo, 0);
            } else if (f === '화성') {
                fAlloc = rItems.filter(r => r.computedFactory.includes('화성') && !r.isAirDist && !String(r.countryVehicle).includes('항공') && !String(r.dbLocation).includes('항공')).reduce((s, r) => s + r.allocatedDist + r.allocatedPo, 0);
            } else {
                fAlloc = rItems.filter(r => r.computedFactory.includes(f)).reduce((s, r) => s + r.allocatedDist + r.allocatedPo, 0);
            }
            allocations[f] = fAlloc;
            sum += fAlloc;
        });
        return { ...d, factoryAllocations: allocations, totalQty: sum };
    });

    setCompareDraft(newCompareDraft);
    setResults(newResults); 
    setItemSummary(newSummary); 
    setUpdatedBacklog(newUpdatedBacklog);
    setDetailResults(newDetailResults);

    setSortConfig({ key: 'reason', direction: 'asc' }); 
    setSortConfigDetail({ key: 'partNumber', direction: 'asc' });
    setSortConfigBacklog({ key: 'partNumber', direction: 'asc' });
    setActiveTab('results'); 
    if (resultSubTab !== 'compare' && resultSubTab !== 'detail' && resultSubTab !== 'updatedBacklog') setResultSubTab('summary');
    
    const currentData = { backlogData, distData: currentDistArr, poDistData, receivingData, factoryDB, factories, suppliers, results: newResults, itemSummary: newSummary, updatedBacklog: newUpdatedBacklog, detailResults: newDetailResults };
    autoSaveToHistory(null, currentData);
  };

  // ⭐️ 완벽 픽스: 팝업창을 띄우지 않고 표 내부에서 즉시 수기 배정을 처리합니다!
  const submitInlineAdj = () => {
      const qty = parseInt(inlineAdj.val);
      if (isNaN(qty) || qty <= 0) { setInlineAdj(null); return; }
      if (qty > inlineAdj.maxQty) { alert(`최대 가능 수량(${inlineAdj.maxQty.toLocaleString()}개)을 초과할 수 없습니다.`); return; }
      
      const delta = inlineAdj.isAdd ? qty : -qty;
      const newAdjs = [...manualAdjustments, { pn: inlineAdj.pn, poNo: inlineAdj.poNo, poItem: inlineAdj.poItem, factory: inlineAdj.factory, delta }];
      setManualAdjustments(newAdjs);
      setInlineAdj(null);
      // 팝업이 없으므로 포커스 뺏김 현상 없이 즉시 재계산 및 연동됩니다.
      withLoading(() => executeAllocationWithDist(distData, forcedPOMappings, new Set(), newAdjs));
  };

  const executeAllocation = currentDB => {
      setFactoryDB(currentDB);
      executeAllocationWithDist(distData);
  }

  const handleReallocateWithLoad = (pn, fromLoc, toLoc, excessQty) => {
    if(!window.confirm(`[재배정 실행] ${pn}\n${fromLoc} ➔ ${toLoc} (${excessQty}개)`)) return;
    withLoading(() => {
        let remainingToMove = excessQty;
        const newDistData = distData.map(d => {
            if (cleanPN(d.pn) === cleanPN(pn) && (d.factoryAllocations[fromLoc] || 0) > 0 && remainingToMove > 0) {
                const newAlloc = { ...d.factoryAllocations };
                const moveAmount = Math.min(newAlloc[fromLoc], remainingToMove);
                newAlloc[toLoc] = (newAlloc[toLoc] || 0) + moveAmount;
                newAlloc[fromLoc] -= moveAmount; remainingToMove -= moveAmount;
                return { ...d, factoryAllocations: newAlloc };
            }
            return d;
        });
        setDistData(newDistData);
        setReallocatedPNs(prev => new Set(prev).add(`${cleanPN(pn)}_${toLoc === '화성(항공)' ? '유라코퍼레이션-화성' : toLoc}`));
        
        const { newResults, newSummary, newUpdatedBacklog } = runAllocationLogic(backlogData, newDistData, poDistData, receivingData, factories, factoryDB, suppliers, new Set(), manualAdjustments);
        const newDetailResults = newResults.filter(r => r && r.computedFactory !== '창고재고' && (r.allocated > 0 || r.allocatedWarehouse > 0 || String(r.poNo).includes('PO 없음')));

        setResults(newResults); 
        setItemSummary(newSummary); 
        setUpdatedBacklog(newUpdatedBacklog);
        setDetailResults(newDetailResults);
        setSelectedItem(newSummary.find(s => cleanPN(s.pn) === cleanPN(pn)));
    });
  };

  const handleReallocateToInventoryWithLoad = (pn, fromLoc, excessQty, inventoryType = '재고') => {
    const displayType = inventoryType === '재고' ? '미배정 재고 창고이동' : '미배정 판매재고 이동';
    if(!window.confirm(`[${displayType} 실행] ${pn}\n${fromLoc} ➔ ${displayType} (${excessQty}개)`)) return;
    withLoading(() => {
        let remainingToMove = excessQty;
        const newDistData = distData.map(d => {
            if (cleanPN(d.pn) === cleanPN(pn) && (d.factoryAllocations[fromLoc] || 0) > 0 && remainingToMove > 0) {
                const newAlloc = { ...d.factoryAllocations };
                const moveAmount = Math.min(newAlloc[fromLoc], remainingToMove);
                newAlloc[fromLoc] -= moveAmount; remainingToMove -= moveAmount;
                if (inventoryType === '재고') return { ...d, factoryAllocations: newAlloc, warehouseStock: (d.warehouseStock || 0) + moveAmount };
                else if (inventoryType === '판매재고') return { ...d, factoryAllocations: newAlloc, salesStock: (d.salesStock || 0) + moveAmount };
            }
            return d;
        });
        setDistData(newDistData);
        
        if (inventoryType === '판매재고') setReallocatedPNs(prev => new Set(prev).add(`${cleanPN(pn)}_판매재고`));
        else setReallocatedPNs(prev => new Set(prev).add(`${cleanPN(pn)}_창고재고`));
        
        const { newResults, newSummary, newUpdatedBacklog } = runAllocationLogic(backlogData, newDistData, poDistData, receivingData, factories, factoryDB, suppliers, new Set(), manualAdjustments);
        const newDetailResults = newResults.filter(r => r && r.computedFactory !== '창고재고' && (r.allocated > 0 || r.allocatedWarehouse > 0 || String(r.poNo).includes('PO 없음')));

        setResults(newResults); 
        setItemSummary(newSummary); 
        setUpdatedBacklog(newUpdatedBacklog);
        setDetailResults(newDetailResults);
        setSelectedItem(newSummary.find(s => cleanPN(s.pn) === cleanPN(pn)));
    });
  };

  const getActualAllocated = (pn, factory) => {
      const bItems = results.filter(r => r._cleanPN === cleanPN(pn));
      if (factory === 'Stock' || factory === '창고재고') return bItems.filter(r => r.computedFactory === '창고재고').reduce((s, r) => s + r.allocatedWarehouse, 0);
      if (factory === 'Total') return bItems.filter(r => r.computedFactory !== '창고재고' && r.computedFactory !== '판매').reduce((s, r) => s + r.allocatedDist + r.allocatedAuto + r.allocatedPo, 0);
      if (factory === '판매') return bItems.filter(r => r.computedFactory === '판매').reduce((s, r) => s + r.allocatedDist + r.allocatedAuto + r.allocatedPo, 0);

      const searchKey = factory === '화성(항공)' ? '유라코퍼레이션-화성' : factory;
      let fItems = bItems.filter(r => r.computedFactory.includes(searchKey));
      if (factory === '화성(항공)') fItems = fItems.filter(r => r.isAirDist === true);
      else if (factory === '화성') fItems = fItems.filter(r => r.isAirDist !== true && !(String(r.countryVehicle).includes('항공') || String(r.dbLocation).includes('항공')));
      return fItems.reduce((s, r) => s + r.allocatedDist + r.allocatedAuto + r.allocatedPo, 0);
  };

  const inputSums = useMemo(() => ({
      recv: receivingData.reduce((acc, row) => acc + (row.qty || 0), 0),
      backlog: backlogData.reduce((acc, row) => acc + (row.pendingQty || 0), 0),
      dist: distData.reduce((acc, row) => acc + (row.totalQty || 0), 0),
      poDist: poDistData.reduce((acc, row) => acc + (row.qty || 0), 0)
  }), [receivingData, backlogData, distData, poDistData]);

  const summaryCounts = useMemo(() => ({
    totalReceived: receivingData.reduce((acc, row) => acc + row.qty, 0),
    totalDist: results.filter(r => r.computedFactory !== '창고재고').reduce((acc, row) => acc + (row.allocatedDist || 0) + (row.allocatedPo || 0), 0),
    totalAuto: results.filter(r => r.computedFactory !== '창고재고').reduce((acc, row) => acc + (row.allocatedAuto || 0), 0),
    totalWarehouse: results.filter(r => r.computedFactory === '창고재고').reduce((acc, row) => acc + (row.allocatedWarehouse || 0), 0),
    totalAllocated: results.filter(r => r.computedFactory !== '창고재고').reduce((acc, row) => acc + (row.allocated || 0), 0)
  }), [results, receivingData]);

  const createSortHandler = (config, setConfig) => (key) => {
      withLoading(() => {
          const direction = (config && config.key === key && config.direction === 'asc') ? 'desc' : 'asc';
          setConfig({ key, direction });
      });
  };

  const requestSort = createSortHandler(sortConfig, setSortConfig);
  const requestSortDetail = createSortHandler(sortConfigDetail, setSortConfigDetail);
  const requestSortBacklog = createSortHandler(sortConfigBacklog, setSortConfigBacklog);
  const requestSortFactory = createSortHandler(sortConfigFactory, setSortConfigFactory);
  const requestSortRecv = createSortHandler(sortConfigRecv, setSortConfigRecv);
  const requestSortBacklogInput = createSortHandler(sortConfigBacklogInput, setSortConfigBacklogInput);
  const requestSortDist = createSortHandler(sortConfigDist, setSortConfigDist);
  const requestSortPoDist = createSortHandler(sortConfigPoDist, setSortConfigPoDist);

  const genericSort = (arr, config) => {
      if (!config || !config.key) return arr;
      return [...arr].sort((a, b) => {
          let aVal = a[config.key]; let bVal = b[config.key];
          if (config.key.startsWith('factory_')) {
              const fName = config.key.replace('factory_', '');
              aVal = a.factoryAllocations?.[fName] || 0; bVal = b.factoryAllocations?.[fName] || 0;
          }
          if (aVal === bVal) return 0;
          if (aVal == null) return 1; if (bVal == null) return -1;
          if (typeof aVal === 'string') return config.direction === 'asc' ? aVal.localeCompare(String(bVal), undefined, {numeric: true}) : String(bVal).localeCompare(aVal, undefined, {numeric: true});
          return config.direction === 'asc' ? (aVal < bVal ? -1 : 1) : (aVal > bVal ? -1 : 1);
      });
  };

  const filteredRecvData = useMemo(() => { if (!inputSearchQuery) return receivingData; return receivingData.filter(r => cleanPN(r.yuraPN).includes(cleanPN(inputSearchQuery))); }, [receivingData, inputSearchQuery]);
  const filteredBacklogData = useMemo(() => { if (!inputSearchQuery) return backlogData; return backlogData.filter(r => cleanPN(r.partNumber).includes(cleanPN(inputSearchQuery))); }, [backlogData, inputSearchQuery]);
  const filteredDistData = useMemo(() => { if (!inputSearchQuery) return distData; return distData.filter(r => cleanPN(r.pn).includes(cleanPN(inputSearchQuery))); }, [distData, inputSearchQuery]);
  const filteredPoDistData = useMemo(() => { if (!inputSearchQuery) return poDistData; return poDistData.filter(r => cleanPN(r.yuraPN).includes(cleanPN(inputSearchQuery))); }, [poDistData, inputSearchQuery]);

  const sortedReceivingData = useMemo(() => genericSort(filteredRecvData, sortConfigRecv), [filteredRecvData, sortConfigRecv]);
  const sortedBacklogData = useMemo(() => genericSort(filteredBacklogData, sortConfigBacklogInput), [filteredBacklogData, sortConfigBacklogInput]);
  const sortedDistData = useMemo(() => genericSort(filteredDistData, sortConfigDist), [filteredDistData, sortConfigDist]);
  const sortedPoDistData = useMemo(() => genericSort(filteredPoDistData, sortConfigPoDist), [filteredPoDistData, sortConfigPoDist]);

  const sortedFactoryDB = useMemo(() => {
      let sortableItems = [...factoryDB];
      if (sortConfigFactory !== null) {
          sortableItems.sort((a, b) => {
              let aVal = a ? a[sortConfigFactory.key] : undefined; let bVal = b ? b[sortConfigFactory.key] : undefined;
              if (aVal === bVal) return 0; if (aVal == null) return 1; if (bVal == null) return -1;
              if (typeof aVal === 'boolean') return sortConfigFactory.direction === 'asc' ? (aVal ? -1 : 1) : (aVal ? 1 : -1);
              return sortConfigFactory.direction === 'asc' ? String(aVal).localeCompare(String(bVal)) : String(bVal).localeCompare(String(aVal));
          });
      }
      return sortableItems;
  }, [factoryDB, sortConfigFactory]);

  const sortedItemSummary = useMemo(() => {
      let sortableItems = [...itemSummary];
      if (sortConfig !== null && sortConfig.key) {
          sortableItems.sort((a, b) => {
              let aValue = a[sortConfig.key]; 
              let bValue = b[sortConfig.key];

              if (sortConfig.key === 'reason') {
                  // ⭐️ 빈 값(정상) 처리: 오름차순/내림차순 상관없이 무조건 맨 아래로 보냅니다.
                  const aEmpty = !aValue || String(aValue).trim() === '';
                  const bEmpty = !bValue || String(bValue).trim() === '';

                  if (aEmpty && !bEmpty) return 1;  // a가 빈값이면 밑으로
                  if (!aEmpty && bEmpty) return -1; // b가 빈값이면 밑으로
                  if (aEmpty && bEmpty) return b.totalAllocQty - a.totalAllocQty; // 둘 다 빈값이면 수량순 정렬

                  // ⭐️ 보여지는 텍스트(가나다) 기준으로 정렬합니다.
                  const compareResult = String(aValue).localeCompare(String(bValue), 'ko-KR');
                  if (compareResult !== 0) {
                      return sortConfig.direction === 'asc' ? compareResult : -compareResult;
                  }
                  
                  // 텍스트가 똑같으면 배정 수량이 많은 순서대로 정렬
                  return b.totalAllocQty - a.totalAllocQty;
              }

              // 다른 컬럼(숫자 등) 일반 정렬 로직
              if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
              if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
              return 0;
          });
      }
      return sortableItems;
  }, [itemSummary, sortConfig]);

  const sortedDetailResults = useMemo(() => {
      let sortableItems = [...detailResults];
      if (sortConfigDetail !== null && sortConfigDetail.key) {
          sortableItems.sort((a, b) => {
              let aVal = a[sortConfigDetail.key]; let bVal = b[sortConfigDetail.key];
              if (sortConfigDetail.key === 'allocatedDist') { aVal = a.allocatedDist + (a.allocatedPo || 0); bVal = b.allocatedDist + (b.allocatedPo || 0); }
              if (aVal === bVal) return 0; if (aVal == null) return 1; if (bVal == null) return -1;
              if (typeof aVal === 'string') return sortConfigDetail.direction === 'asc' ? aVal.localeCompare(String(bVal), undefined, {numeric: true}) : String(bVal).localeCompare(aVal, undefined, {numeric: true});
              return sortConfigDetail.direction === 'asc' ? (aVal < bVal ? -1 : 1) : (aVal > bVal ? -1 : 1);
          });
      } else {
          sortableItems.sort((a, b) => cleanPN(a.partNumber).localeCompare(cleanPN(b.partNumber)) || sortByDueDateAndPO(a, b));
      }
      return sortableItems;
  }, [detailResults, sortConfigDetail]);

  const updatedBacklogResults = useMemo(() => {
      let sortableItems = [...updatedBacklog];
      if (sortConfigBacklog !== null && sortConfigBacklog.key) {
          sortableItems.sort((a, b) => {
              let aVal = a[sortConfigBacklog.key]; let bVal = b[sortConfigBacklog.key];
              if (sortConfigBacklog.key === 'allocatedDist') { aVal = a.allocatedDist + (a.allocatedPo || 0); bVal = b.allocatedDist + (b.allocatedPo || 0); }
              if (sortConfigBacklog.key === 'remaining') { aVal = a.pendingQty - a.allocated; bVal = b.pendingQty - b.allocated; }
              if (aVal === bVal) return 0; if (aVal == null) return 1; if (bVal == null) return -1;
              if (typeof aVal === 'string') return sortConfigBacklog.direction === 'asc' ? aVal.localeCompare(String(bVal), undefined, {numeric: true}) : String(bVal).localeCompare(aVal, undefined, {numeric: true});
              return sortConfigBacklog.direction === 'asc' ? (aVal < bVal ? -1 : 1) : (aVal > bVal ? -1 : 1);
          });
      }
      return sortableItems;
  }, [updatedBacklog, sortConfigBacklog]);

  const handleSearchEnter = () => {
      if (!searchQuery) return;
      const match = itemSummary.find(item => cleanPN(item.pn) === cleanPN(searchQuery));
      if (match) setSelectedItem(match);
      else alert('검색된 품번이 없습니다.');
  };

  // ⭐️ 신규: 다중 조건(PO부족/입고부족/배정차이) 에러 핀셋 필터링
  const filteredSummary = useMemo(() => {
      let res = sortedItemSummary;
      if (searchQuery) {
          const sq = cleanPN(searchQuery);
          res = res.filter(item => cleanPN(item.pn).includes(sq));
      }
      if (showAppendedOnly) res = res.filter(item => item.isAppended);
      
      const isFilterActive = errorFilters.shortage || errorFilters.distOverRecv || errorFilters.allocDiff;
      if (isFilterActive) {
          res = res.filter(item => {
              if (errorFilters.shortage && item.hasShortage) return true;
              if (errorFilters.distOverRecv && item.hasDistOverRecv) return true;
              if (errorFilters.allocDiff && item.hasAllocDiff) return true;
              return false;
          });
      }
      return res;
  }, [sortedItemSummary, searchQuery, showAppendedOnly, errorFilters]);

  const filteredDetail = useMemo(() => {
      let res = sortedDetailResults;
      if (searchQuery) {
          const sq = cleanPN(searchQuery);
          res = res.filter(item => cleanPN(item.partNumber).includes(sq));
      }
      if (showAppendedOnly) res = res.filter(item => item.isAppendedDist || item.isAppendedRecv || item.isAppended);
      return res;
  }, [sortedDetailResults, searchQuery, showAppendedOnly]);

  const filteredBacklog = useMemo(() => {
      let res = updatedBacklogResults;
      if (searchQuery) {
          const sq = cleanPN(searchQuery);
          res = res.filter(item => cleanPN(item.partNumber).includes(sq));
      }
      if (showAppendedOnly) res = res.filter(item => item.isAppendedDist || item.isAppendedRecv || item.isAppended);
      return res;
  }, [updatedBacklogResults, searchQuery, showAppendedOnly]);

  
  const updateFactoryDB = (id, field, value) => { setFactoryDB(prev => prev.map(db => db.id === id ? { ...db, [field]: value } : db)); };
  const toggleFactoryDBCustom = (id, isCustom) => { setFactoryDB(prev => prev.map(db => db.id === id ? { ...db, isCustom, wmsFactory: '' } : db)); };
  const removeFactoryDBRow = id => { if(window.confirm("항목을 삭제하시겠습니까?")) setFactoryDB(prev => prev.filter(db => db.id !== id)); };

  const copyToClipboard = content => {
    const textArea = document.createElement("textarea"); textArea.value = content; document.body.appendChild(textArea); textArea.select();
    document.execCommand('copy'); document.body.removeChild(textArea);
  };

  const handleMissingMappingChange = (index, value) => { const updated = [...missingDBMapping]; updated[index] = { ...updated[index], wmsFactory: value }; setMissingDBMapping(updated); };
  const handleMissingMappingCustomToggle = (index, isCustom) => { const updated = [...missingDBMapping]; updated[index] = { ...updated[index], isCustom, wmsFactory: '' }; setMissingDBMapping(updated); };

  const saveMissingMappingAndProceed = () => {
      if (missingDBMapping.some(m => !m.wmsFactory || !m.wmsFactory.trim())) { if (!window.confirm("공장이 선택되지 않은 항목은 '미매칭' 처리됩니다. 계속하시겠습니까?")) return; }
      let updatedDB = [...factoryDB];
      missingDBMapping.forEach(m => {
          if (m.wmsFactory && m.wmsFactory.trim()) {
              if (m.isNew) { updatedDB.push({ id: `fdb-${Date.now()}-${Math.random()}`, countryVehicle: m.countryVehicle, location: m.location, wmsFactory: m.wmsFactory, dPlus: '', isCurrentMonthOnly: false, isExcluded: false, isCustom: false }); } 
              else { const dbIdx = updatedDB.findIndex(db => db.countryVehicle === m.countryVehicle); if (dbIdx > -1) updatedDB[dbIdx].wmsFactory = m.wmsFactory; }
          }
      });
      setFactoryDB(updatedDB); setMissingDBMapping(null); executeAllocation(updatedDB);
  };

  // ⭐️ 픽스 1: "발주 잔량 남음"을 파란색(참고 상태)으로 변경
  const getReasonClass = reason => {
      if (!reason) return ''; // ⭐️ 빈 메세지일 경우 스타일 없음 (투명 처리)
      if (reason.includes('PO 부족')) return 'bg-rose-50 text-rose-600 border-rose-200 animate-pulse';
      if (reason.includes('지시초과')) return 'bg-orange-50 text-orange-600 border-orange-200 animate-pulse';
      if (reason.includes('배정 차이') || reason.includes('공장오류')) return 'bg-amber-50 text-amber-600 border-amber-200';
      if (reason.includes('미배정') || reason.includes('창고재고') || reason.includes('잔여')) return 'bg-blue-50 text-blue-600 border-blue-100';
      return 'bg-emerald-50 text-emerald-600 border-emerald-100';
  };

  const getTypeLabel = (r, isRe) => {
      if (r.computedFactory === '창고재고') return <span className="bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">창고재고</span>;
      if (isRe) return <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px] animate-pulse shadow-sm">재배정</span>;
      if (r.allocated === 0 && r.allocatedWarehouse === 0) return '-';
      if (r.allocatedPo > 0) return <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">PO지정</span>;
      if (r.allocatedDist > 0) return <span className="bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">지시</span>;
      if (r.allocatedAuto > 0) return <span className="bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">자동</span>;
      return '-';
  };

  const SortIcon = ({ column, config }) => {
      if (!config || config.key !== column) return null;
      return config.direction === 'asc' ? <ChevronUp size={12} className="inline ml-1"/> : <ChevronDown size={12} className="inline ml-1"/>;
  };

  // ⭐️ 픽스 2: 수량을 직접 읽어와서 원하는 만큼만 쪼개서 배정하도록 기능 고도화
  const applyReallocation = (pn, loc, maxQty) => {
      const selectEl = document.getElementById(`realloc-${pn}-${loc}`);
      const qtyEl = document.getElementById(`realloc-qty-${pn}-${loc}`);
      if (!selectEl || !qtyEl) return;
      
      const val = selectEl.value;
      const qty = parseInt(qtyEl.value.replace(/,/g, ''));
      
      if (isNaN(qty) || qty <= 0) { alert('올바른 이동 수량을 입력하세요.'); return; }
      if (qty > maxQty) { alert(`초과 수량(${maxQty.toLocaleString()}개)보다 많이 지정할 수 없습니다.`); return; }
      
      if (val === 'INVENTORY') handleReallocateToInventoryWithLoad(pn, loc, qty, '재고');
      else if (val === 'SALES') handleReallocateToInventoryWithLoad(pn, loc, qty, '판매재고');
      else handleReallocateWithLoad(pn, loc, val, qty);
  };

  const exportDetailToExcel = () => {
    const headers = ['상태', '배정유형', '국가/차종', '부품사', '출고처', 'WMS공장', 'YURA PN', '업체품번', 'PO번호', '항번', '납품일정', '주문량', '미결량', '지시배정량', '자동배정량', '창고재고', '총배정수량', '비고'];
    const rows = filteredDetail.map(row => {
      let typeStr = [];
      if (row.allocatedDist > 0 || row.allocatedPo > 0) typeStr.push('지시');
      if (row.allocatedAuto > 0) typeStr.push('자동');
      if (row.allocatedWarehouse > 0) typeStr.push('창고재고');
      if (reallocatedPNs.has(`${cleanPN(row.partNumber)}_${row.computedFactory}`)) typeStr.push('재배정');
      return [row.computedFactory === '창고재고' ? '입고잔여' : (row.allocated >= row.pendingQty ? '완납' : '미납'), typeStr.join('/'), row.countryVehicle, row.supplier, row.dbLocation, row.computedFactory, row.partNumber, row.supplierPN || '-', row.poNo, row.poItem, row.dueDate, row.orderQty, row.pendingQty, row.allocatedDist + (row.allocatedPo||0), row.allocatedAuto, row.allocatedWarehouse || 0, row.allocated, (row.isAppendedDist || row.isAppendedRecv || row.isAppended) ? '추가' : ''];
    });
    copyToClipboard([headers, ...rows].map(r => r.join('\t')).join('\n')); autoSaveToHistory('전체 배정 내역 복사됨');
  };

  const exportUpdatedBacklogToExcel = () => {
    const headers = ['상태', '국가/차종', '부품사', 'YURA PN', '업체품번', 'PO NO', '항번', '납기일자', '기존 미결량', '지시 배정', '자동 배정', '창고재고', '배정 합계', '배정 후 미결', '가용재고 차감', '최종 잔여 미결', '비고'];
    const rows = filteredBacklog.map(row => {
      const stateLabel = row.computedFactory === '창고재고' ? '입고잔여' : (row.newPending <= 0 ? '완납종결' : '잔량남음');
      return [stateLabel, row.countryVehicle, row.supplier, row.partNumber, row.supplierPN || '-', row.poNo, row.poItem, row.dueDate, row.pendingQty, row.allocatedDist + (row.allocatedPo || 0), row.allocatedAuto, row.allocatedWarehouse || 0, row.allocated, row.computedFactory === '창고재고' ? '-' : row.pendingQty - row.allocated, row.computedFactory === '창고재고' ? '-' : row.stockApplied, row.computedFactory === '창고재고' ? '-' : row.newPending, (row.isAppendedDist || row.isAppendedRecv || row.isAppended) ? '추가' : ''];
    });
    copyToClipboard([headers, ...rows].map(r => r.join('\t')).join('\n')); alert('갱신 리포트 복사됨');
  };

  const exportSelectedItemToExcel = () => {
    const detailItems = sortedDetailResults.filter(b => cleanPN(b.partNumber) === cleanPN(selectedItem.pn));
    const headers = ["유형", "국가/차종", "부품사", "WMS공장", "YURA PN", "업체품번", "PO No", "항번", "납기", "주문량", "미결량", "창고재고", "배정수량", "비고"];
    const rows = detailItems.map(r => {
      let typeStr = [];
      if (r.allocatedDist > 0 || r.allocatedPo > 0) typeStr.push('지시');
      if (r.allocatedAuto > 0) typeStr.push('자동');
      if (r.allocatedWarehouse > 0) typeStr.push('창고재고');
      if (reallocatedPNs.has(`${cleanPN(r.partNumber)}_${r.computedFactory}`)) typeStr.push('재배정');
      return [typeStr.join('/'), r.countryVehicle, r.supplier, r.computedFactory, r.partNumber, r.supplierPN || '-', r.poNo, r.poItem, r.dueDate, r.orderQty, r.pendingQty, r.allocatedWarehouse || 0, r.allocated, (r.isAppendedDist || r.isAppendedRecv || r.isAppended) ? '추가' : ''];
    });
    copyToClipboard([headers, ...rows].map(r => r.join('\t')).join('\n')); alert('데이터가 엑셀로 복사되었습니다.');
  };

  const existingWmsFactoriesList = useMemo(() => {
      const safeFactories = Array.isArray(factories) ? factories : [];
      const safeFactoryDB = Array.isArray(factoryDB) ? factoryDB : [];
      const wmsList = [...safeFactories.filter(f => f && f !== '자동배정'), ...safeFactoryDB.map(db => db?.wmsFactory)];
      return [...new Set(wmsList.filter(f => f && typeof f === 'string' && f.trim() !== ''))].sort();
  }, [factoryDB, factories]);

  const memoizedRecvTable = useMemo(() => (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
        <thead className="bg-slate-900 text-white font-bold sticky top-0 z-20 shadow-sm"><tr><th className="p-3 w-3/5 cursor-pointer hover:bg-slate-800" onClick={() => requestSortRecv('yuraPN')}>YURA PN<SortIcon column="yuraPN" config={sortConfigRecv}/></th><th className="p-3 w-1/5 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortRecv('qty')}>Qty<SortIcon column="qty" config={sortConfigRecv}/></th><th className="p-3 w-1/5 text-center text-amber-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortRecv('isAppended')}>비고<SortIcon column="isAppended" config={sortConfigRecv}/></th></tr></thead>
        <tbody className="divide-y divide-slate-50 select-text">
            {sortedReceivingData.length === 0 ? (<tr><td colSpan="3" className="p-0"><div className="flex flex-col items-center justify-center h-[300px] opacity-40 text-center pointer-events-none"><p className="font-black text-sm text-slate-900 mb-1 italic uppercase">Click & Paste</p><p className="text-[9px] font-bold text-slate-500">YURA PN / 수량</p></div></td></tr>) : (sortedReceivingData.map((r, i) => (<tr key={r.id||i} className={`transition-colors ${r.isAppended ? 'bg-amber-50/40 hover:bg-amber-100/50' : 'hover:bg-blue-50/30'}`}><td className="p-3 font-black text-slate-800">{r.yuraPN}</td><td className="p-3 text-right font-black text-blue-700">{r.qty.toLocaleString()}</td><td className="p-3 text-center">{r.isAppended && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[8px] font-black">추가등록</span>}</td></tr>)))}
        </tbody>
    </table>
  ), [sortedReceivingData, sortConfigRecv]);

  const memoizedBacklogTable = useMemo(() => (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
        <thead className="bg-slate-900 text-white font-bold sticky top-0 z-20 shadow-sm"><tr><th className="p-3 text-indigo-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('countryVehicle')}>국가/차종<SortIcon column="countryVehicle" config={sortConfigBacklogInput}/></th><th className="p-3 text-indigo-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('supplier')}>부품사<SortIcon column="supplier" config={sortConfigBacklogInput}/></th><th className="p-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('partNumber')}>YURA PN<SortIcon column="partNumber" config={sortConfigBacklogInput}/></th><th className="p-3 text-emerald-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('supplierPN')}>업체품번<SortIcon column="supplierPN" config={sortConfigBacklogInput}/></th><th className="p-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('poNo')}>PO NO<SortIcon column="poNo" config={sortConfigBacklogInput}/></th><th className="p-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('poItem')}>항번<SortIcon column="poItem" config={sortConfigBacklogInput}/></th><th className="p-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('dueDate')}>납기일자<SortIcon column="dueDate" config={sortConfigBacklogInput}/></th><th className="p-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('orderQty')}>주문량<SortIcon column="orderQty" config={sortConfigBacklogInput}/></th><th className="p-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('deliveredQty')}>출고량<SortIcon column="deliveredQty" config={sortConfigBacklogInput}/></th><th className="p-3 text-right text-amber-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('pendingQty')}>미결량<SortIcon column="pendingQty" config={sortConfigBacklogInput}/></th><th className="p-3 text-right text-slate-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklogInput('availableStock')}>가용재고<SortIcon column="availableStock" config={sortConfigBacklogInput}/></th></tr></thead>
        <tbody className="divide-y divide-slate-100 select-text">
            {sortedBacklogData.length === 0 ? (<tr><td colSpan="11" className="p-0"><div className="flex flex-col items-center justify-center h-[300px] opacity-40 text-center pointer-events-none"><p className="font-black text-sm text-slate-900 mb-1 italic">CLICK & PASTE</p><p className="text-[9px] font-bold text-slate-500">국가차종/부품사/PN/업체품번/PO/항번/납기/주문/출고/미결/가용재고 (11개 열)</p></div></td></tr>) : (sortedBacklogData.map(r => (<tr key={r.id} className="hover:bg-indigo-50/30 transition-all"><td className="p-3 font-bold text-indigo-600">{r.countryVehicle}</td><td className="p-3 font-bold text-indigo-600">{r.supplier}</td><td className="p-3 font-black text-slate-800">{r.partNumber}</td><td className="p-3 font-bold text-emerald-600">{r.supplierPN}</td><td className="p-3 text-slate-400 font-mono">{r.poNo}</td><td className="p-3 text-slate-400 font-bold">{r.poItem}</td><td className="p-3 font-bold">{r.dueDate}</td><td className="p-3 text-right text-slate-400">{r.orderQty.toLocaleString()}</td><td className="p-3 text-right text-slate-400">{r.deliveredQty.toLocaleString()}</td><td className="p-3 text-right font-black text-amber-600">{r.pendingQty.toLocaleString()}</td><td className="p-3 text-right text-slate-400">{r.availableStock}</td></tr>)))}
        </tbody>
    </table>
  ), [sortedBacklogData, sortConfigBacklogInput]);

  const memoizedDistTable = useMemo(() => (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
        <thead className="bg-slate-900 text-white font-bold sticky top-0 z-20 shadow-sm"><tr><th className="p-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDist('pn')}>YURA PN<SortIcon column="pn" config={sortConfigDist}/></th><th className="p-3 text-emerald-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDist('supplierPN')}>업체품번<SortIcon column="supplierPN" config={sortConfigDist}/></th><th className="p-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortDist('totalQty')}>Total<SortIcon column="totalQty" config={sortConfigDist}/></th>{(factories||[]).map((f,i) => <th key={f||i} className="p-3 text-right text-slate-400 font-normal cursor-pointer hover:bg-slate-800" onClick={() => requestSortDist(`factory_${f}`)}>{f}<SortIcon column={`factory_${f}`} config={sortConfigDist}/></th>)}<th className="p-3 text-right text-emerald-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDist('warehouseStock')}>Stock<SortIcon column="warehouseStock" config={sortConfigDist}/></th><th className="p-3 text-center text-amber-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDist('isAppended')}>비고<SortIcon column="isAppended" config={sortConfigDist}/></th></tr></thead>
        <tbody className="divide-y divide-slate-100 select-text">
            {sortedDistData.length === 0 ? (<tr><td colSpan={factories.length + 5} className="p-0"><div className="flex flex-col items-center justify-center h-[280px] opacity-40 text-center pointer-events-none"><p className="font-black text-sm text-slate-900 mb-1 italic">CLICK & PASTE</p><p className="text-[9px] font-bold text-slate-500 leading-tight">PN / 업체품번 / Total / 공장명들 순서대로 복사</p></div></td></tr>) : (sortedDistData.map((r, idx) => (<tr key={r.id||idx} className={`transition-all ${r.isAppended ? 'bg-amber-50/40 hover:bg-amber-100/50' : 'hover:bg-emerald-50/30'}`}><td className="p-3 font-bold text-slate-800">{r.pn}</td><td className="p-3 font-bold text-emerald-600">{r.supplierPN}</td><td className="p-3 text-right font-black text-indigo-600">{r.totalQty.toLocaleString()}</td>{(factories||[]).map((f,i) => <td key={f||i} className="p-3 text-right text-slate-500">{r.factoryAllocations[f]?.toLocaleString() || 0}</td>)}<td className="p-3 text-right text-emerald-600 font-black">{r.warehouseStock.toLocaleString()}</td><td className="p-3 text-center">{r.isAppended && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[8px] font-black">추가등록</span>}</td></tr>)))}
        </tbody>
    </table>
  ), [sortedDistData, sortConfigDist, factories]);

  const memoizedPoDistTable = useMemo(() => (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
        <thead className="bg-slate-900 text-white font-bold sticky top-0 z-20 shadow-sm"><tr><th className="p-2.5 cursor-pointer hover:bg-slate-800" onClick={() => requestSortPoDist('yuraPN')}>YURA PN<SortIcon column="yuraPN" config={sortConfigPoDist}/></th><th className="p-2.5 cursor-pointer hover:bg-slate-800" onClick={() => requestSortPoDist('poNo')}>PO No<SortIcon column="poNo" config={sortConfigPoDist}/></th><th className="p-2.5 cursor-pointer hover:bg-slate-800" onClick={() => requestSortPoDist('poItem')}>항번<SortIcon column="poItem" config={sortConfigPoDist}/></th><th className="p-2.5 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortPoDist('qty')}>Qty<SortIcon column="qty" config={sortConfigPoDist}/></th></tr></thead>
        <tbody className="divide-y divide-slate-100 select-text">
            {sortedPoDistData.length === 0 ? (<tr><td colSpan="4" className="p-0"><div className="flex flex-col items-center justify-center h-[280px] opacity-40 text-center pointer-events-none"><p className="font-black text-sm text-slate-900 mb-1 italic">CLICK & PASTE</p><p className="text-[9px] font-bold text-slate-500 leading-tight">YURA PN / PO No / 항번 / 수량 (4열)</p></div></td></tr>) : (sortedPoDistData.map(r => (<tr key={r.id} className="hover:bg-purple-50/30 transition-all"><td className="p-2.5 font-bold text-slate-800">{r.yuraPN}</td><td className="p-2.5 font-bold text-slate-600 font-mono">{r.poNo}</td><td className="p-2.5 font-bold text-slate-500">{r.poItem}</td><td className="p-2.5 text-right font-black text-purple-600">{r.qty.toLocaleString()}</td></tr>)))}
        </tbody>
    </table>
  ), [sortedPoDistData, sortConfigPoDist]);

  const memoizedFactoryDBTable = useMemo(() => (
    <table className="w-full text-left text-xs whitespace-nowrap">
      <thead className="bg-slate-900 text-white sticky top-0 z-10 uppercase tracking-widest text-[10px]">
        <tr>
          <th className="p-3 font-bold w-1/4 cursor-pointer hover:bg-slate-800" onClick={() => requestSortFactory('countryVehicle')}>국가/차종<SortIcon column="countryVehicle" config={sortConfigFactory}/></th>
          <th className="p-3 font-bold w-1/4 cursor-pointer hover:bg-slate-800" onClick={() => requestSortFactory('location')}>출고처<SortIcon column="location" config={sortConfigFactory}/></th>
          <th className="p-3 font-bold cursor-pointer hover:bg-slate-800" onClick={() => requestSortFactory('wmsFactory')}>WMS 공장<SortIcon column="wmsFactory" config={sortConfigFactory}/></th>
          <th className="p-3 w-16 text-center cursor-pointer hover:bg-slate-800" onClick={() => requestSortFactory('dPlus')}>D+출고제한<SortIcon column="dPlus" config={sortConfigFactory}/></th>
          <th className="p-3 w-16 text-center cursor-pointer hover:bg-slate-800" onClick={() => requestSortFactory('isCurrentMonthOnly')}>당월납기<SortIcon column="isCurrentMonthOnly" config={sortConfigFactory}/></th>
          <th className="p-3 w-16 text-center cursor-pointer hover:bg-slate-800" onClick={() => requestSortFactory('isExcluded')}>분배제외<SortIcon column="isExcluded" config={sortConfigFactory}/></th>
          <th className="p-3 w-12 text-center">X</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {sortedFactoryDB.map(db => (
          <tr key={db.id} className="hover:bg-sky-50/30 transition-colors">
            <td className="p-3 font-black text-indigo-700">{db.countryVehicle}</td>
            <td className="p-3"><input type="text" value={db.location || ''} onChange={(e) => updateFactoryDB(db.id, 'location', e.target.value)} className="w-full px-2 py-1 bg-transparent border-b border-transparent focus:border-sky-300 outline-none font-bold text-slate-600" /></td>
            <td className="p-3">
              {db.isCustom ? (
                <div className="flex gap-2 items-center"><input type="text" value={db.wmsFactory || ''} onChange={(e) => updateFactoryDB(db.id, 'wmsFactory', e.target.value)} className="w-full px-3 py-1.5 rounded-lg outline-none font-black shadow-inner border border-sky-300 bg-sky-50 text-sky-800 text-[11px]" autoFocus /><button onClick={() => toggleFactoryDBCustom(db.id, false)} className="p-1.5 bg-slate-100 rounded text-slate-400 hover:text-slate-600"><X size={14}/></button></div>
              ) : (
                <select value={db.wmsFactory || ''} onChange={(e) => e.target.value === '__CUSTOM__' ? toggleFactoryDBCustom(db.id, true) : updateFactoryDB(db.id, 'wmsFactory', e.target.value)} className={`w-full px-3 py-1.5 rounded-lg outline-none font-black shadow-sm border transition-all text-[11px] ${!db.wmsFactory ? 'bg-rose-50 border-rose-300 focus:border-rose-500 text-rose-700' : 'bg-slate-50 border-slate-200 focus:border-sky-500 text-slate-700'}`}><option value="">== 선택 없음 ==</option>{existingWmsFactoriesList.map((f,i) => <option key={f||i} value={f}>{f}</option>)}<option value="__CUSTOM__">✏️ 직접 입력</option></select>
              )}
            </td>
            <td className="p-3 text-center"><input type="number" value={db.dPlus !== undefined ? db.dPlus : ''} onChange={(e) => updateFactoryDB(db.id, 'dPlus', e.target.value)} className="w-12 text-[11px] font-bold text-center outline-none text-indigo-600 border border-slate-200 rounded py-1 bg-white" placeholder="∞" title="자동배분 D+ 출고제한" /></td>
            <td className="p-3 text-center"><input type="checkbox" checked={!!db.isCurrentMonthOnly} onChange={e => updateFactoryDB(db.id, 'isCurrentMonthOnly', e.target.checked)} className="w-4 h-4 accent-indigo-600 cursor-pointer block mx-auto" /></td>
            <td className="p-3 text-center"><input type="checkbox" checked={!!db.isExcluded} onChange={e => updateFactoryDB(db.id, 'isExcluded', e.target.checked)} className="w-4 h-4 accent-rose-500 cursor-pointer block mx-auto" /></td>
            <td className="p-3 text-center"><button onClick={() => removeFactoryDBRow(db.id)} className="p-1.5 text-slate-300 hover:text-rose-500 rounded-lg transition-colors"><Trash2 size={14}/></button></td>
          </tr>
        ))}
      </tbody>
    </table>
  ), [sortedFactoryDB, sortConfigFactory, existingWmsFactoriesList]);

  const memoizedSummaryTable = useMemo(() => (
    <table className="w-full text-left text-[11px] whitespace-nowrap">
      <thead className="bg-slate-900 text-white font-black sticky top-0 z-20 uppercase border-b border-slate-800">
        <tr>
          <th className="px-6 py-4 cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('pn')}><div className="flex items-center gap-1">YURA PN <SortIcon column="pn" config={sortConfig}/></div></th>
          <th className="px-6 py-4 cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('supplierPN')}><div className="flex items-center gap-1 text-emerald-300">업체품번 <SortIcon column="supplierPN" config={sortConfig}/></div></th>
          <th className="px-6 py-4 text-center cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('reason')}><div className="flex items-center justify-center gap-1">분석 및 분류 <SortIcon column="reason" config={sortConfig}/></div></th>
          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('poQty')}><div className="flex items-center justify-end gap-1">PO 발주 <SortIcon column="poQty" config={sortConfig}/></div></th>
          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('distQty')}><div className="flex items-center justify-end gap-1">분배 지시 <SortIcon column="distQty" config={sortConfig}/></div></th>
          <th className="px-6 py-4 text-right cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('recvQty')}><div className="flex items-center justify-end gap-1">당일 입고 <SortIcon column="recvQty" config={sortConfig}/></div></th>
          <th className="px-6 py-4 text-right text-emerald-400 shadow-xl cursor-pointer hover:bg-slate-800 transition-colors" onClick={() => requestSort('totalAllocQty')}><div className="flex items-center justify-end gap-1">최종 배정 <SortIcon column="totalAllocQty" config={sortConfig}/></div></th>
          <th className="px-6 py-4 text-center">상세</th>
          <th className="px-6 py-4 text-center text-amber-300">비고</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {filteredSummary.map((row, idx) => (
          <tr key={idx} onClick={() => setSelectedItem(row)} className={`transition-all cursor-pointer group ${row.isAppended ? 'bg-amber-50/20 hover:bg-amber-50/60' : 'hover:bg-slate-50'}`}>
            <td className="px-6 py-4 font-black text-slate-900 text-[11px] underline decoration-slate-200 underline-offset-4">{row.pn}</td>
            <td className="px-6 py-4 font-bold text-emerald-600 text-[10px]">{row.supplierPN}</td>
            {/* ⭐️ 라벨 텍스트가 있을 때만 예쁜 네모 박스를 그리고, 없으면 짝대기(-) 처리 */}
            <td className="px-6 py-4 text-center">{row.reason ? <span className={`px-3 py-1.5 rounded-lg text-[9px] font-bold border ${getReasonClass(row.reason)}`}>{row.reason}</span> : <span className="text-slate-300">-</span>}</td>
            <td className="px-6 py-4 text-right font-mono text-slate-500">{row.poQty.toLocaleString()}</td>
            <td className="px-6 py-4 text-right font-mono text-indigo-500">{row.distQty.toLocaleString()}</td>
            <td className="px-6 py-4 text-right font-mono text-blue-500">{row.recvQty.toLocaleString()}</td>
            <td className="px-6 py-4 text-right font-black text-emerald-600 text-xs shadow-inner bg-emerald-50/20">{row.totalAllocQty.toLocaleString()}</td>
            <td className="px-6 py-4 text-center text-slate-300 group-hover:text-indigo-600"><Search size={14} /></td>
            <td className="px-6 py-4 text-center">{row.isAppended ? <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[9px] font-black">추가</span> : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ), [filteredSummary, sortConfig]);

  const memoizedDetailTable = useMemo(() => (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
      <thead className="bg-slate-900 text-white font-black sticky top-0 z-20 uppercase">
        <tr>
          <th className="px-4 py-3 text-center cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('allocated')}>유형<SortIcon column="allocated" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('countryVehicle')}>국가/차종<SortIcon column="countryVehicle" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('supplier')}>부품사<SortIcon column="supplier" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 text-indigo-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('computedFactory')}>WMS공장<SortIcon column="computedFactory" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('partNumber')}>YURA PN<SortIcon column="partNumber" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800 text-emerald-300" onClick={() => requestSortDetail('supplierPN')}>업체품번<SortIcon column="supplierPN" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('poNo')}>PO No<SortIcon column="poNo" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('poItem')}>항번<SortIcon column="poItem" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('dueDate')}>납기<SortIcon column="dueDate" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('pendingQty')}>미결량<SortIcon column="pendingQty" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('allocatedDist')}>지시량<SortIcon column="allocatedDist" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('allocatedAuto')}>자동량<SortIcon column="allocatedAuto" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortDetail('allocatedWarehouse')}>창고재고<SortIcon column="allocatedWarehouse" config={sortConfigDetail}/></th>
          <th className="px-5 py-3 text-right bg-indigo-800 shadow-xl font-black cursor-pointer hover:bg-indigo-700" onClick={() => requestSortDetail('allocated')}>최종배정량<SortIcon column="allocated" config={sortConfigDetail}/></th>
          <th className="px-4 py-3 text-center text-amber-300">비고</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {filteredDetail.map(row => { 
          const isRe = reallocatedPNs.has(`${cleanPN(row.partNumber)}_${row.computedFactory}`); 
          const isAdded = row.isAppendedDist || row.isAppendedRecv || row.isAppended;
          return (
            <tr key={row.id} className={`transition-all group ${isAdded ? 'bg-amber-50/30 hover:bg-amber-50/60' : 'hover:bg-slate-50'}`}>
              <td className="px-4 py-2 text-center flex flex-wrap justify-center gap-1">{getTypeLabel(row, isRe)}</td>
              <td className="px-4 py-2 font-bold text-slate-500">{row.countryVehicle}</td>
              <td className="px-4 py-2 font-bold text-slate-500">{row.supplier}</td>
              <td className="px-4 py-2 font-black text-indigo-600 uppercase tracking-tighter">{row.computedFactory}</td>
              <td className="px-4 py-2 font-black text-slate-900 text-[10px]">{row.partNumber}</td>
              <td className="px-4 py-2 font-bold text-emerald-600">{row.supplierPN || '-'}</td>
              <td className="px-4 py-2 font-mono text-slate-400">{row.poNo}</td>
              <td className="px-4 py-2 font-bold text-slate-700">{row.poItem}</td>
              <td className="px-4 py-2 font-bold text-indigo-500">{row.dueDate}</td>
              <td className="px-4 py-2 text-right text-slate-400">{row.pendingQty.toLocaleString()}</td>
              <td className="px-4 py-2 text-right text-indigo-400 font-bold">{row.allocatedDist > 0 || row.allocatedPo > 0 ? (row.allocatedDist + (row.allocatedPo || 0)).toLocaleString() : '-'}</td>
              <td className="px-4 py-2 text-right text-teal-500 font-bold">{row.allocatedAuto > 0 ? row.allocatedAuto.toLocaleString() : '-'}</td>
              <td className="px-4 py-2 text-right text-slate-500 font-bold">{row.allocatedWarehouse > 0 ? row.allocatedWarehouse.toLocaleString() : '-'}</td>
              <td className="px-5 py-2 text-right bg-indigo-50/20 font-black text-indigo-700 text-[11px]">{row.allocated.toLocaleString()}</td>
              <td className="px-4 py-2 text-center">{isAdded ? <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[9px] font-black">추가</span> : '-'}</td>
            </tr>
          ); 
        })}
      </tbody>
    </table>
  ), [filteredDetail, sortConfigDetail, reallocatedPNs]);

  const memoizedUpdatedBacklogTable = useMemo(() => (
    <table className="w-full text-left text-[10px] whitespace-nowrap">
      <thead className="bg-slate-900 text-white font-black sticky top-0 z-20 uppercase">
        <tr>
          <th className="px-4 py-3 text-center cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('newPending')}>상태<SortIcon column="newPending" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-indigo-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('countryVehicle')}>국가/차종<SortIcon column="countryVehicle" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-indigo-300 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('supplier')}>부품사<SortIcon column="supplier" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('partNumber')}>YURA PN<SortIcon column="partNumber" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800 text-emerald-300" onClick={() => requestSortBacklog('supplierPN')}>업체품번<SortIcon column="supplierPN" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('poNo')}>PO No<SortIcon column="poNo" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('poItem')}>항번<SortIcon column="poItem" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('dueDate')}>납기<SortIcon column="dueDate" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('pendingQty')}>기존 미결<SortIcon column="pendingQty" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-indigo-400 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('allocatedDist')}>지시 배정<SortIcon column="allocatedDist" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-teal-400 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('allocatedAuto')}>자동 배정<SortIcon column="allocatedAuto" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-slate-400 cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('allocatedWarehouse')}>창고재고<SortIcon column="allocatedWarehouse" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-emerald-400 font-black cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('allocated')}>배정 합계<SortIcon column="allocated" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-amber-300 italic cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('remaining')}>배정 후 미결<SortIcon column="remaining" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-blue-400 shadow-xl italic cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('stockApplied')}>가용재고 차감<SortIcon column="stockApplied" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-right text-rose-500 font-black cursor-pointer hover:bg-slate-800" onClick={() => requestSortBacklog('newPending')}>최종 잔여 미결<SortIcon column="newPending" config={sortConfigBacklog}/></th>
          <th className="px-4 py-3 text-center text-amber-300">비고</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {filteredBacklog.map(row => {
          const isAdded = row.isAppendedDist || row.isAppendedRecv || row.isAppended;
          return (
          <tr key={row.id} className={`transition-all group ${row.newPending <= 0 && row.computedFactory !== '창고재고' ? 'bg-slate-100 opacity-50' : (isAdded ? 'bg-amber-50/20 hover:bg-amber-50/50' : 'hover:bg-indigo-50/30')}`}>
            <td className="px-4 py-2 text-center">{row.computedFactory === '창고재고' ? <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">입고잔여</span> : (row.newPending <= 0 ? <span className="bg-slate-200 text-slate-500 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">완납종결</span> : <span className="bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-[4px] font-bold text-[8px]">잔량남음</span>)}</td>
            <td className="px-4 py-2 font-bold text-indigo-600">{row.countryVehicle}</td>
            <td className="px-4 py-2 font-bold text-indigo-600">{row.supplier}</td>
            <td className="px-4 py-2 font-black text-slate-900 text-[10px]">{row.partNumber}</td>
            <td className="px-4 py-2 font-bold text-emerald-600">{row.supplierPN || '-'}</td>
            <td className="px-4 py-2 font-mono text-slate-400">{row.poNo}</td>
            <td className="px-4 py-2 font-bold text-slate-700">{row.poItem}</td>
            <td className="px-4 py-2 font-bold text-slate-700">{row.dueDate}</td>
            <td className="px-4 py-2 text-right text-slate-400">{row.pendingQty.toLocaleString()}</td>
            <td className="px-4 py-2 text-right font-bold text-indigo-600">{(row.allocatedDist + (row.allocatedPo || 0)).toLocaleString()}</td>
            <td className="px-4 py-2 text-right font-bold text-teal-600">{row.allocatedAuto.toLocaleString()}</td>
            <td className="px-4 py-2 text-right font-bold text-slate-500 bg-slate-50">{row.allocatedWarehouse > 0 ? row.allocatedWarehouse.toLocaleString() : '-'}</td>
            <td className="px-4 py-2 text-right font-black text-emerald-600">{row.allocated.toLocaleString()}</td>
            <td className="px-4 py-2 text-right font-black text-amber-600 text-[11px]">{row.computedFactory === '창고재고' ? '-' : row.pendingQty - row.allocated}</td>
            <td className="px-4 py-2 text-right font-bold text-blue-500 shadow-inner">{row.computedFactory === '창고재고' ? '-' : (row.stockApplied > 0 ? `-${row.stockApplied.toLocaleString()}` : '-')}</td>
            <td className="px-4 py-2 text-right font-black text-rose-500 text-[11px] bg-rose-50/30">{row.computedFactory === '창고재고' ? '-' : row.newPending.toLocaleString()}</td>
            <td className="px-4 py-2 text-center">{isAdded ? <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[9px] font-black">추가</span> : '-'}</td>
          </tr>
        )})}
      </tbody>
    </table>
  ), [filteredBacklog, sortConfigBacklog]);

  // Modal Render Functions
  const renderMissingDBModal = () => {
    if (!missingDBMapping) return null;
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex justify-center items-center p-6 animate-modal">
         <div className="bg-white w-full max-w-3xl max-h-[80vh] rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden border border-slate-200">
            <div className="px-8 py-5 bg-rose-50 border-b border-rose-100 flex justify-between items-center"><h3 className="text-xl font-black text-rose-700 flex items-center gap-3 italic"><AlertTriangle className="text-rose-600"/> WMS 공장 매칭 필요 알림</h3><button onClick={() => setMissingDBMapping(null)} className="p-2 text-rose-400 hover:text-rose-900"><X size={20} /></button></div>
            <div className="p-8 flex-1 overflow-auto custom-scrollbar flex flex-col gap-6 min-h-0">
                <p className="text-sm font-bold text-slate-700 leading-relaxed uppercase tracking-tighter">WMS 공장 매칭 데이터가 누락된 항목이 <span className="text-rose-600 font-black">{missingDBMapping.length}건</span> 있습니다.<br/>아래에서 공장을 선택하거나 직접 수기로 입력해주세요.</p>
                <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-sm flex-1 min-h-0 flex flex-col">
                    <table className="w-full text-left text-xs"><thead className="bg-slate-100 text-slate-600 border-b border-slate-200 sticky top-0 z-10 uppercase tracking-widest font-black"><tr><th className="p-3 w-1/3">국가/차종</th><th className="p-3 w-1/3">출고처(참고)</th><th className="p-3 w-1/3">WMS 공장 선택</th></tr></thead></table>
                    <div className="flex-1 overflow-auto min-h-0">
                      <table className="w-full text-left text-xs">
                        <tbody className="divide-y divide-slate-100">
                          {missingDBMapping.map((item, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="p-3 w-1/3 font-black text-indigo-700">{item.countryVehicle}</td>
                              <td className="p-3 w-1/3 text-slate-500 font-bold">{item.location}</td>
                              <td className="p-3 w-1/3">
                                {item.isCustom ? (
                                  <div className="flex gap-2 items-center"><input type="text" autoFocus className="w-full px-3 py-2 border border-indigo-300 rounded-lg outline-none font-bold text-indigo-700 bg-indigo-50 shadow-inner" value={item.wmsFactory} onChange={(e) => handleMissingMappingChange(idx, e.target.value)} placeholder="WMS 공장 수기 입력" /><button onClick={() => handleMissingMappingCustomToggle(idx, false)} className="p-2 text-slate-400 hover:text-slate-600 bg-slate-100 rounded-lg"><X size={16} /></button></div>
                                ) : (
                                  <select className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none font-bold text-slate-700 bg-white" value={item.wmsFactory} onChange={(e) => e.target.value === '__CUSTOM__' ? handleMissingMappingCustomToggle(idx, true) : handleMissingMappingChange(idx, e.target.value)}><option value="">== 선택 없음 ==</option>{existingWmsFactoriesList.map((f,i) => (<option key={f||i} value={f}>{f}</option>))}<option value="__CUSTOM__">✏️ 직접 수기 입력...</option></select>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-2"><button onClick={() => setMissingDBMapping(null)} className="px-6 py-3 bg-slate-200 text-slate-700 font-bold rounded-xl hover:bg-slate-300 transition-colors uppercase tracking-widest text-xs font-black">Cancel</button><button onClick={saveMissingMappingAndProceed} className="px-8 py-3 bg-indigo-600 text-white font-black rounded-xl hover:bg-indigo-700 shadow-md transition-colors active:scale-95 uppercase tracking-widest text-xs font-black">Save & Process</button></div>
            </div>
         </div>
      </div>
    );
  };

  const renderDetailModal = () => {
    if (!selectedItem) return null;
    const allItemPOs = results.filter(b => cleanPN(b.partNumber) === cleanPN(selectedItem.pn)).sort(sortByDueDateAndPO);
    const unallocatedPOs = allItemPOs.filter(b => (b.pendingQty - b.allocated) > 0);
    const unallocatedTotal = allItemPOs.filter(b => b.computedFactory === '창고재고' || b.computedFactory === '미배정(지시초과)').reduce((sum, b) => sum + (b.allocatedWarehouse || 0), 0);

    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex justify-center items-center p-6 animate-modal">
        <div className="bg-white w-full max-w-7xl max-h-[90vh] rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden border border-slate-200 select-text">
           <div className="px-8 py-5 bg-slate-50 border-b border-slate-200 flex justify-between items-center shrink-0">
             <h3 className="text-xl font-black text-slate-900 flex items-center gap-3 uppercase tracking-tighter italic">
               <Box className="text-indigo-600"/> 
               <span className="cursor-pointer hover:text-indigo-600 flex items-center gap-1.5 group" onClick={() => { copyToClipboard(selectedItem.pn); alert('품번이 복사되었습니다.'); }} title="클릭하여 품번 복사">
                 {selectedItem.pn}
                 <Clipboard size={16} className="opacity-0 group-hover:opacity-100 transition-opacity text-indigo-500" />
               </span>
               배정 상세 분석
             </h3>
             <div className="flex items-center gap-2"><button onClick={exportSelectedItemToExcel} className="px-4 py-2 bg-indigo-100 text-indigo-700 hover:bg-indigo-200 rounded-xl font-bold text-xs uppercase tracking-tighter italic">Export to Excel</button><button onClick={() => setSelectedItem(null)} className="p-2 text-slate-400 hover:text-slate-900"><X size={20} /></button></div>
           </div>
           <div className="p-8 overflow-auto custom-scrollbar flex-1 space-y-6 min-h-0">
              <div className="grid grid-cols-5 gap-4 shrink-0">
                <div className="bg-slate-50 p-4 rounded-2xl shadow-inner"><p className="text-[10px] text-slate-400 font-bold uppercase">PO 총계</p><p className="text-lg font-black">{selectedItem.poQty.toLocaleString()}</p></div>
                <div className="bg-indigo-50 p-4 rounded-2xl text-indigo-700 shadow-inner"><p className="text-[10px] text-indigo-400 font-bold uppercase">지시 수량</p><p className="text-lg font-black">{selectedItem.distQty.toLocaleString()}</p></div>
                <div className="bg-blue-50 p-4 rounded-2xl text-blue-700 shadow-inner"><p className="text-[10px] text-blue-400 font-bold uppercase">입고 수량</p><p className="text-lg font-black">{selectedItem.recvQty.toLocaleString()}</p></div>
                <div className="bg-emerald-50 p-4 rounded-2xl text-emerald-700 shadow-inner"><p className="text-[10px] text-emerald-400 font-bold uppercase">최종 배정</p><p className="text-lg font-black">{selectedItem.totalAllocQty.toLocaleString()}</p></div>
                <div className="bg-rose-50 p-4 rounded-2xl text-rose-700 shadow-inner border border-rose-200"><p className="text-[10px] text-rose-400 font-bold uppercase">미배정 잔량</p><p className="text-lg font-black">{unallocatedTotal.toLocaleString()}</p></div>
              </div>

              {selectedItem.shortages?.length > 0 && (
                <div className="bg-rose-50 border border-rose-200 p-5 rounded-2xl shadow-inner">
                  <h4 className="font-black text-rose-700 mb-3 flex items-center gap-2 text-xs uppercase italic animate-pulse"><AlertTriangle size={14} /> ⚠️ Critical: 배정할 PO 부족 현상 감지</h4>
                  <div className="flex flex-col gap-4">
                    {selectedItem.shortages.map(short => (
                      // ⭐️ 에러 픽스: key에 short.qty를 추가하여, 수량이 변할 때마다 낡은 입력칸을 강제로 초기화하여 먹통을 방지합니다!
                      <div key={`${short.loc}-${short.qty}`} className="flex flex-col gap-3 p-5 bg-white rounded-xl border border-rose-100 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-1 h-full bg-rose-500"></div>
                        <span className="text-sm font-black text-rose-600 block leading-relaxed">
                            <span className="bg-rose-600 text-white px-2 py-0.5 rounded text-xs mr-2 uppercase">Shortage</span>
                            <span className="text-blue-600 font-extrabold text-base">[{short.loc}]</span> 공장에 더이상 배정할 PO가 부족합니다. 
                            (초과 수량: <span className="text-blue-600 font-extrabold text-base">{short.qty.toLocaleString()}</span>개)
                            <br/><span className="text-slate-400 font-bold text-xs mt-1 block italic underline underline-offset-4">다른 공장으로 배정 또는 재고로 이관(확정)해주시기 바랍니다. (수량을 수정하여 일부만 이관할 수도 있습니다)</span>
                        </span>
                        <div className="flex flex-col sm:flex-row gap-2 items-center bg-slate-50 p-3 rounded-lg border border-slate-100 mt-1">
                          <select id={`realloc-${selectedItem.pn}-${short.loc}`} className="w-full sm:w-1/2 px-3 py-2 border border-slate-300 rounded-lg text-xs font-black text-slate-700 outline-none focus:border-indigo-500 shadow-sm bg-white">
                            <option value="INVENTORY">➔ 미배정 재고 창고이동 (확정)</option><option value="SALES">➔ 미배정 판매재고 이동 (확정)</option>
                            {unallocatedPOs.length > 0 && (<optgroup label="--- 잔여 PO 목록 (타 공장/차종) ---">{unallocatedPOs.map(po => (<option key={po.id} value={po.computedFactory}>[{po.computedFactory}] {po.poNo} (납기: {po.dueDate}) - 잔량: {(po.pendingQty - po.allocated).toLocaleString()}개</option>))}</optgroup>)}
                          </select>
                          {/* ⭐️ 수량을 직접 입력할 수 있는 텍스트 박스 UI 추가! */}
                          <div className="w-full sm:w-1/4 relative">
                            <input 
                                type="text" 
                                id={`realloc-qty-${selectedItem.pn}-${short.loc}`} 
                                defaultValue={short.qty.toLocaleString()} 
                                onBlur={e => { const val = parseInt(e.target.value.replace(/,/g, '')); if (!isNaN(val)) e.target.value = val.toLocaleString(); }} 
                                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-black text-right outline-none focus:border-indigo-500 shadow-sm text-indigo-700 bg-white pr-8" 
                                placeholder="이동 수량" 
                                style={{ pointerEvents: 'auto', userSelect: 'text' }} 
                            />
                            <span className="absolute right-3 top-2 text-[10px] text-slate-400 font-bold">개</span>
                          </div>
                          <button onClick={() => applyReallocation(selectedItem.pn, short.loc, short.qty)} className="w-full sm:w-1/4 bg-rose-600 text-white px-3 py-2 rounded-lg text-xs font-black shadow-lg hover:bg-rose-700 transition-all active:scale-95 uppercase tracking-tighter">적용 (Apply)</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                <table className="w-full text-left text-[11px] whitespace-nowrap">
                  <thead className="bg-slate-900 text-white font-black sticky top-0 z-20 uppercase tracking-widest italic shadow-lg">
                    <tr><th className="p-3 text-center">유형/상태</th><th className="p-3 text-indigo-300">매칭WMS공장</th><th className="p-3">원본출고처</th><th className="p-3">PO No</th><th className="p-3">항번</th><th className="p-3">납기</th><th className="p-3 text-emerald-300">업체품번</th><th className="p-3 text-right">미결수량</th><th className="p-3 text-right bg-emerald-600 shadow-xl font-black">배정결과</th><th className="p-3 text-center">수기 조작</th><th className="p-3 text-center text-amber-300">비고</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {allItemPOs.map(r => {
                        const isRe = reallocatedPNs.has(`${cleanPN(r.partNumber)}_${r.computedFactory}`);
                        return (
                          <tr key={r.id} className={`transition-colors ${r.allocated > 0 ? "bg-white hover:bg-slate-50" : "bg-slate-50/50 opacity-60 hover:opacity-100"}`}>
                            <td className="p-3 text-center">
                              {r.computedFactory === '창고재고' || r.computedFactory === '미배정(지시초과)' ? <span className="bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-[4px] font-bold text-[9px]">{r.computedFactory}</span> : (isRe ? <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[9px] font-bold animate-pulse shadow-sm">재배정</span> : (r.allocated > 0 ? (r.allocatedPo > 0 ? <span className="bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-[4px] font-bold text-[9px]">PO지정</span> : (r.allocatedDist > 0 ? '지시' : '자동')) : '-'))}
                            </td>
                            <td className="p-3 font-black text-indigo-600 uppercase italic tracking-tighter shadow-inner bg-indigo-50/10">{r.computedFactory}</td>
                            <td className="p-3 font-bold text-slate-400 uppercase tracking-tighter">{r.dbLocation}</td>
                            <td className="p-3 font-mono text-slate-500">{r.poNo}</td>
                            <td className="p-3 font-bold text-slate-600">{r.poItem}</td>
                            <td className="p-3 text-indigo-600 font-bold">{r.dueDate}</td>
                            <td className="p-3 font-bold text-emerald-600">{r.supplierPN || '-'}</td>
                            <td className="p-3 text-right text-slate-500 font-bold">{r.pendingQty.toLocaleString()}</td>
                            <td className="p-3 text-right font-black text-emerald-600 bg-emerald-50/20 shadow-inner text-sm">
                               {r.computedFactory === '창고재고' || r.computedFactory === '미배정(지시초과)' ? (r.allocatedWarehouse || 0).toLocaleString() : r.allocated.toLocaleString()}
                            </td>
                            <td className="p-3 text-center w-36">
                              {r.computedFactory !== '창고재고' && !String(r.poNo).includes('PO 없음') && (
                                 inlineAdj?.id === r.id ? (
                                     <div className="flex items-center justify-center gap-1">
                                         <input type="text" autoFocus value={inlineAdj.val} onChange={e => setInlineAdj({...inlineAdj, val: e.target.value.replace(/[^0-9]/g, '')})} onKeyDown={e => e.key === 'Enter' && submitInlineAdj()} className="w-14 px-1 py-1 text-[10px] font-black text-center border border-indigo-400 rounded outline-none text-slate-800 bg-white" placeholder={`최대 ${inlineAdj.maxQty}`} />
                                         <button onClick={submitInlineAdj} className="px-2 py-1 bg-indigo-600 text-white rounded text-[10px] font-black hover:bg-indigo-700 shadow-sm active:scale-95">✓ 확인</button>
                                         <button onClick={() => setInlineAdj(null)} className="px-2 py-1 bg-slate-200 text-slate-600 rounded text-[10px] font-bold hover:bg-slate-300">취소</button>
                                     </div>
                                 ) : (
                                     <div className="flex justify-center gap-1.5">
                                         {r.allocated > 0 ? <button onClick={() => setInlineAdj({ id: r.id, pn: r.partNumber, poNo: r.poNo, poItem: r.poItem, factory: r.computedFactory, isAdd: false, maxQty: r.allocated, val: '' })} className="px-2 py-1 bg-rose-100 text-rose-700 rounded font-black text-[10px] hover:bg-rose-200 shadow-sm active:scale-95 transition-all">- 취소</button> : <span className="w-[42px]"></span>}
                                         {(r.pendingQty - r.allocated) > 0 && unallocatedTotal > 0 ? <button onClick={() => setInlineAdj({ id: r.id, pn: r.partNumber, poNo: r.poNo, poItem: r.poItem, factory: r.computedFactory, isAdd: true, maxQty: Math.min(r.pendingQty - r.allocated, unallocatedTotal), val: '' })} className="px-2 py-1 bg-indigo-100 text-indigo-700 rounded font-black text-[10px] hover:bg-indigo-200 shadow-sm active:scale-95 transition-all">+ 배정</button> : <span className="w-[42px]"></span>}
                                     </div>
                                 )
                              )}
                            </td>
                            <td className="p-3 text-center font-bold text-amber-500">{(r.isAppendedDist || r.isAppendedRecv || r.isAppended) ? '추가' : ''}</td>
                          </tr>
                        );
                    })}
                  </tbody>
                </table>
              </div>
           </div>
        </div>
      </div>
    );
  };

  const renderHistoryModal = () => {
    if (!showHistoryModal) return null;
    return (
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex justify-center items-center p-6 animate-modal">
         <div className="bg-white w-full max-w-3xl max-h-[80vh] rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden border border-slate-200">
            <div className="px-8 py-5 bg-slate-50 border-b border-slate-200 flex justify-between items-center"><h3 className="text-xl font-black text-slate-900 flex items-center gap-3 uppercase tracking-tighter italic"><History className="text-indigo-600"/> History Management</h3><button onClick={() => setShowHistoryModal(false)} className="p-2 text-slate-400 hover:text-slate-900"><X size={20} /></button></div>
            <div className="p-8 flex-1 overflow-auto custom-scrollbar flex flex-col gap-6 min-h-0">
                <div className="flex gap-2"><input type="text" value={newHistoryName} onChange={e => setNewHistoryName(e.target.value)} placeholder="저장할 데이터의 이름 (예: 2026-03-20 오전 배정완료)" className="flex-1 px-4 py-3 rounded-xl border border-slate-300 font-bold outline-none focus:border-indigo-500" /><button onClick={() => saveCurrentState(null)} className="px-6 py-3 bg-indigo-600 text-white font-black rounded-xl hover:bg-indigo-700 flex items-center gap-2 shadow-md"><Save size={16} /> 현재 상태 저장</button></div>
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-2 flex flex-col flex-1 min-h-[300px]">
                    {historyList.length === 0 ? (
                        <div className="flex-1 flex flex-col justify-center items-center text-slate-400"><Database size={40} className="mb-2 opacity-50"/><p className="font-bold text-sm">저장된 데이터베이스가 없습니다.</p></div>
                    ) : (
                        <ul className="divide-y divide-slate-200">
                            {historyList.map((h, i) => (
                                <li key={h.id||i} className="flex justify-between items-center p-4 hover:bg-white rounded-xl transition-colors">
                                    <div><p className="font-black text-slate-800 text-base uppercase">{h.name}</p><p className="text-[10px] text-slate-500 font-bold mt-1">Saved At: {h.date}</p></div>
                                    <div className="flex gap-2">
                                        <button onClick={() => loadState(h)} className="px-4 py-2 bg-emerald-100 text-emerald-700 font-bold rounded-lg text-xs hover:bg-emerald-200 flex items-center gap-1.5 shadow-sm"><FolderDown size={14} /> 불러오기</button>
                                        <button onClick={() => deleteState(h.id)} className="p-2 bg-rose-50 text-rose-500 rounded-lg hover:bg-rose-100"><Trash2 size={16} /></button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
         </div>
      </div>
    );
  };

  // --- 컴포넌트 렌더링 로직 ---
  return (
    <div className="h-screen bg-slate-50 font-sans text-slate-800 flex flex-col overflow-hidden">
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #64748b; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .select-text { -webkit-user-select: text; user-select: text; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fade-in { animation: fadeIn 0.3s ease-out forwards; }
        @keyframes modalShow { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .animate-modal { animation: modalShow 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .paste-area:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.2); }
      `}</style>

      {isLoading && (
          <div className="fixed inset-0 bg-white/60 backdrop-blur-sm z-[9999] flex flex-col justify-center items-center">
              <Loader2 className="text-indigo-600 animate-spin mb-4" size={48} />
              <p className="text-indigo-800 font-black text-lg animate-pulse tracking-widest uppercase">Processing Data...</p>
          </div>
      )}

      {/* Append Modal */}
      {appendModal.isOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex justify-center items-center p-6 animate-modal">
              <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-slate-200">
                  <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
                      <h3 className="font-black text-slate-800 flex items-center gap-2">{appendModal.title}</h3>
                      <button onClick={() => setAppendModal({isOpen:false, type:null, title:''})} className="text-slate-400 hover:text-slate-900"><X size={20}/></button>
                  </div>
                  <div className="p-6 flex flex-col gap-4">
                      <p className="text-xs font-bold text-indigo-600 bg-indigo-50 px-4 py-2 rounded-lg">
                         💡 <strong>누적 입력 모드:</strong> 입력하신 데이터는 기존 항목을 지우지 않고 <strong className="text-rose-600">추가분으로 누적 반영</strong>됩니다.<br/>
                         {appendModal.type === 'recv' ? "* 형식: YURA PN, 수량(Qty) (2열 탭 복사)" : "* 형식: YURA PN, 업체품번, Total, 각 공장 분배량들, Stock (N열 탭 복사)"}
                      </p>
                      <textarea 
                          className="w-full h-64 p-4 border border-slate-300 rounded-xl outline-none focus:border-indigo-500 text-[10px] custom-scrollbar leading-relaxed font-mono select-text" 
                          placeholder="여기에 엑셀 데이터를 붙여넣으세요 (Ctrl+V)..."
                          value={appendInput}
                          onChange={(e) => setAppendInput(e.target.value)}
                      />
                      <div className="flex justify-end gap-2 mt-2">
                          <button className="px-5 py-2.5 bg-slate-200 text-slate-700 font-bold rounded-xl text-xs hover:bg-slate-300" onClick={() => setAppendModal({isOpen:false, type:null, title:''})}>취소</button>
                          <button className="px-5 py-2.5 bg-indigo-600 text-white font-black rounded-xl text-xs shadow hover:bg-indigo-700" onClick={handleAppendSave}>저장 및 누적 추가</button>
                      </div>
                  </div>
              </div>
          </div>
      )}

      <header className="bg-slate-900 border-b border-slate-800 shrink-0 z-30 shadow-xl h-24 flex items-center">
        <div className="max-w-[1900px] mx-auto px-10 w-full flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="bg-indigo-600 p-3 rounded-xl text-white shadow-lg"><Monitor size={28} /></div>
            <div>
              <h1 className="text-xl font-black text-white tracking-tighter leading-none uppercase">PO 자동 배정 프로그램</h1>
              <div className="flex items-center gap-2 mt-1.5"><span className="text-[10px] font-bold text-slate-400 tracking-widest uppercase italic">SlicerPro Logic v10.5 Stable</span><span className="text-[10px] text-indigo-400 font-black px-2 py-0.5 bg-indigo-500/10 rounded-full">제작: 슬라이서프로</span></div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowHistoryModal(true)} className="px-5 py-2.5 bg-slate-800 text-slate-300 rounded-xl font-bold hover:bg-slate-700 hover:text-white transition-all text-xs flex items-center gap-2 border border-slate-700"><History size={14}/> 일자별 DB 관리</button>
            <button onClick={clearAll} className="px-5 py-2.5 rounded-xl font-bold text-slate-400 hover:text-white transition-all text-xs border border-slate-700 hover:border-slate-500 uppercase tracking-widest">Reset Work</button>
            <button onClick={() => withLoading(processAllocation)} className={`px-10 py-3 rounded-xl font-black shadow-xl transition-all active:scale-95 text-sm ${backlogData.length > 0 ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-indigo-500/40' : 'bg-slate-800 text-slate-600 cursor-not-allowed'}`}>자동 배정 실행</button>
          </div>
        </div>
      </header>

      <nav className="max-w-[1900px] mx-auto px-10 flex gap-2 pt-4 shrink-0 w-full z-20 relative">
          {[
            { id: 'input', label: '1. PO 데이터 입력', icon: Database, color: 'indigo' },
            { id: 'db', label: '2. 기준정보 관리', icon: Link2, color: 'sky' },
            { id: 'results', label: '3. 배정 결과 리포트', icon: BarChart3, color: 'emerald' },
            { id: 'inventory', label: '4. 재고 실사 분석', icon: PackageCheck, color: 'orange' },
            { id: 'info_record', label: '5. 정보레코드 관리 (New)', icon: Clipboard, color: 'purple' },
            { id: 'manual', label: '6. 사용 설명서', icon: Monitor, color: 'rose' }
          ].map(tab => {
            const IconComponent = tab.icon;
            return (
              <button key={tab.id} onClick={() => withLoading(() => setActiveTab(tab.id))} 
                className={`flex items-center gap-2.5 px-8 py-4 font-black text-xs rounded-t-xl transition-all border-b-4 ${activeTab === tab.id ? `bg-white border-${tab.color}-500 text-${tab.color}-700 shadow-sm` : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                <IconComponent size={16} />
                {tab.label}
              </button>
            );
          })}
      </nav>

      <main className={`max-w-[1900px] mx-auto p-6 w-full flex-1 flex flex-col min-h-0 animate-fade-in ${activeTab === 'results' ? 'overflow-hidden' : 'overflow-y-auto'}`}>

        {activeTab === 'inventory' && (
          <div className="flex flex-col h-full gap-6 animate-fade-in">
            <div className="grid grid-cols-3 gap-6 h-1/3 shrink-0">
              <div onPaste={e => parseInventoryData(e, 'sap')} tabIndex={0} className="paste-area bg-white rounded-3xl border-2 border-dashed border-indigo-200 flex flex-col overflow-hidden shadow-sm focus-within:border-indigo-500 outline-none">
                <div className="px-4 py-3 bg-indigo-50 border-b border-indigo-100 font-black text-[11px] text-indigo-800">1. SAP 재고 (품번 / 수량)</div>
                <div className="flex-1 overflow-auto p-4 text-[10px] text-slate-400">
                  {sapStock.length > 0 ? `${sapStock.length}건 입력됨` : "엑셀의 '품번, 수량' 열을 복사해 붙여넣으세요."}
                </div>
              </div>
              <div onPaste={e => parseInventoryData(e, 'loc')} tabIndex={0} className="paste-area bg-white rounded-3xl border-2 border-dashed border-sky-200 flex flex-col overflow-hidden shadow-sm focus-within:border-sky-500 outline-none">
                <div className="px-4 py-3 bg-sky-50 border-b border-sky-100 font-black text-[11px] text-sky-800">2. 로케이션 재고 (위치 / 품번 / 수량)</div>
                <div className="flex-1 overflow-auto p-4 text-[10px] text-slate-400">
                  {locStock.length > 0 ? `${locStock.length}건 입력됨` : "엑셀의 '위치, 품번, 수량' 열을 복사해 붙여넣으세요."}
                </div>
              </div>
              <div onPaste={e => parseInventoryData(e, 'out')} tabIndex={0} className="paste-area bg-white rounded-3xl border-2 border-dashed border-emerald-200 flex flex-col overflow-hidden shadow-sm focus-within:border-emerald-500 outline-none">
                <div className="px-4 py-3 bg-emerald-50 border-b border-emerald-100 font-black text-[11px] text-emerald-800">3. 출고 예정 (공장 / 품번 / 수량)</div>
                <div className="flex-1 overflow-auto p-4 text-[10px] text-slate-400">
                  {outboundStock.length > 0 ? `${outboundStock.length}건 입력됨` : "엑셀의 '공장, 품번, 수량' 열을 복사해 붙여넣으세요."}
                </div>
              </div>
            </div>

            <div className="flex justify-between items-center px-2">
              <div className="flex gap-2 p-1 bg-slate-200 rounded-2xl shadow-inner shrink-0">
                <button onClick={() => setInventorySubTab('summary')} className={`px-8 py-2.5 rounded-xl font-black text-xs transition-all ${inventorySubTab === 'summary' ? 'bg-white text-indigo-700 shadow-md' : 'text-slate-500 hover:text-slate-700'}`}>전체 현황별 요약</button>
                <button onClick={() => setInventorySubTab('location')} className={`px-8 py-2.5 rounded-xl font-black text-xs transition-all ${inventorySubTab === 'location' ? 'bg-white text-indigo-700 shadow-md' : 'text-slate-500 hover:text-slate-700'}`}>로케이션별 상세 현황</button>
              </div>
              <button onClick={runInventoryAudit} className="px-12 py-3.5 bg-orange-600 text-white font-black rounded-2xl shadow-xl hover:bg-orange-500 active:scale-95 transition-all">
                재고 실사 분석 실행
              </button>
            </div>

            <div className="flex-1 bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden flex flex-col min-h-0">
              <div className="px-6 py-4 bg-slate-900 text-white font-black text-sm flex justify-between items-center">
                <span>{inventorySubTab === 'summary' ? '재고 실사 분석 결과 (전체 요약)' : '재고 실사 분석 결과 (로케이션 상세)'}</span>
                <button onClick={() => {
                  let header = ""; let body = "";
                  if (inventorySubTab === 'summary') {
                    header = "품목\t제조사\t유라품번\t업체품번\tSAP재고\t로케이션수량\t출고대기수량\t차이수량\t비고\n";
                    body = inventoryResults.map(r => `${r.itemName}\t${r.manufacturer}\t${r.rawPn}\t${r.supplierPn}\t${r.sapQty}\t${r.locQty}\t${r.outQty}\t${r.diff}\t${r.remark}`).join('\n');
                  } else {
                    header = "위치\t품목\t제조사\t유라품번\t업체품번\t위치별수량\tSAP총재고\t전체차이\t비고\n";
                    body = inventoryLocResults.map(r => `${r.loc}\t${r.itemName}\t${r.manufacturer}\t${r.rawPn}\t${r.supplierPn}\t${r.locQty}\t${r.sapTotalQty}\t${r.totalDiff}\t${r.remark}`).join('\n');
                  }
                  copyToClipboard(header + body);
                  alert("리포트가 클립보드에 복사되었습니다. 엑셀에 붙여넣으세요.");
                }} className="text-xs bg-emerald-600 px-4 py-1.5 rounded-lg hover:bg-emerald-500 font-bold shadow-sm transition-all flex items-center gap-2"><DownloadCloud size={14}/> 엑셀 다운로드 (Copy)</button>
              </div>
              
              <div className="flex-1 overflow-auto custom-scrollbar">
                <table className="w-full text-left text-xs whitespace-nowrap">
                  <thead className="bg-slate-100 sticky top-0 font-bold text-slate-600 border-b border-slate-200 z-10 shadow-sm">
                    {inventorySubTab === 'summary' ? (
                      <tr>
                        <th className="p-4">품목</th><th className="p-4">제조사</th><th className="p-4">유라 품번 (Pn)</th><th className="p-4 text-emerald-600">업체 품번</th><th className="p-4 text-right">SAP 재고</th><th className="p-4 text-right">로케이션 합계</th><th className="p-4 text-right text-orange-600">출고 대기</th><th className="p-4 text-right">차이 수량</th><th className="p-4">비고</th>
                      </tr>
                    ) : (
                      <tr>
                        <th className="p-4 bg-indigo-50 text-indigo-700">창고 위치 (LOC)</th><th className="p-4">품목</th><th className="p-4">제조사</th><th className="p-4">유라 품번 (Pn)</th><th className="p-4 text-emerald-600">업체 품번</th><th className="p-4 text-right text-indigo-600">위치별 수량</th><th className="p-4 text-right">SAP 총재고</th><th className="p-4 text-right font-black">전체 차이</th><th className="p-4">비고</th>
                      </tr>
                    )}
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {inventorySubTab === 'summary' ? (
                      inventoryResults.map((res, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className={`p-4 font-bold ${res.itemName === '임시' ? 'text-slate-300 italic' : 'text-slate-700'}`}>{res.itemName}</td>
                          <td className={`p-4 ${res.manufacturer === '임시' ? 'text-slate-300' : 'font-bold text-purple-700'}`}>{res.manufacturer}</td>
                          <td className="p-4 font-black text-slate-900">{res.rawPn}</td>
                          <td className={`p-4 font-bold ${res.supplierPn === '임시' ? 'text-slate-300' : 'text-emerald-600'}`}>{res.supplierPn}</td>
                          <td className="p-4 text-right font-mono text-slate-600">{res.sapQty.toLocaleString()}</td>
                          <td className="p-4 text-right font-mono text-slate-600">{res.locQty.toLocaleString()}</td>
                          <td className="p-4 text-right font-black text-orange-600 bg-orange-50/30">{res.outQty.toLocaleString()}</td>
                          <td className={`p-4 text-right font-black ${res.diff < 0 ? 'text-rose-600' : res.diff > 0 ? 'text-blue-600' : 'text-slate-400'}`}>{res.diff > 0 ? `+${res.diff.toLocaleString()}` : res.diff.toLocaleString()}</td>
                          <td className="p-4 text-[10px] font-bold text-slate-500">{res.remark !== '-' ? <span className="bg-orange-50 text-orange-700 px-2 py-1 rounded border border-orange-100">{res.remark}</span> : '-'}</td>
                        </tr>
                      ))
                    ) : (
                      inventoryLocResults.map((res, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors group">
                          <td className="p-4 font-black text-indigo-700 bg-indigo-50/20 group-hover:bg-indigo-50 transition-colors">{res.loc}</td>
                          <td className="p-4 text-slate-600">{res.itemName}</td>
                          <td className="p-4 text-purple-700 font-bold">{res.manufacturer}</td>
                          <td className="p-4 font-black">{res.rawPn}</td>
                          <td className="p-4 text-emerald-600 font-bold">{res.supplierPn}</td>
                          <td className="p-4 text-right font-black text-indigo-600 shadow-inner">{res.locQty.toLocaleString()}</td>
                          <td className="p-4 text-right text-slate-400 font-mono">{res.sapTotalQty.toLocaleString()}</td>
                          <td className={`p-4 text-right font-black ${res.totalDiff < 0 ? 'text-rose-600' : 'text-blue-600'}`}>{res.totalDiff.toLocaleString()}</td>
                          <td className="p-4 text-[10px] text-slate-500">{res.remark}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'info_record' && (
          <div className="flex flex-col h-full gap-6 animate-fade-in">
            <div className="flex justify-between items-center bg-white p-6 rounded-3xl shadow-sm border border-slate-200 shrink-0">
              <div className="flex flex-col gap-1">
                <h3 className="text-xl font-black text-purple-800 uppercase italic">Information Record DB</h3>
                <p className="text-xs font-bold text-slate-400">부품 마스터 정보 관리 (전체: {infoRecords.length.toLocaleString()}건)</p>
              </div>
              <div className="flex gap-3">
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-3 text-slate-400" />
                  <input type="text" placeholder="품번으로 마스터 정보 검색..." value={infoRecordSearch} onChange={e => setInfoRecordSearch(e.target.value)} className="pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 text-xs font-bold outline-none focus:border-purple-500 w-64 shadow-inner" />
                </div>
                <div className="flex gap-2">
                  <button onClick={fetchInfoRecordsFromFirebase} disabled={isSyncing} className={`px-4 py-2.5 rounded-xl font-black text-xs shadow-md transition-all flex items-center gap-2 ${isSyncing ? 'bg-slate-200 text-slate-400' : 'bg-white text-purple-700 border border-purple-200 hover:bg-purple-50 active:scale-95'}`}>
                    <DownloadCloud size={14}/> 서버에서 내려받기
                  </button>
                  <button onClick={syncInfoRecordsToFirebase} disabled={isSyncing} className={`px-5 py-2.5 rounded-xl font-black text-xs shadow-lg transition-all flex items-center gap-2 ${isSyncing ? 'bg-slate-400' : 'bg-purple-600 text-white hover:bg-purple-500 active:scale-95'}`}>
                    {isSyncing ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
                    클라우드로 백업 (업로드)
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden flex flex-col min-h-0">
              <div onPaste={parseInfoRecordData} tabIndex={0} className="p-5 bg-purple-50 border-b border-purple-100 text-center cursor-pointer hover:bg-purple-100 transition-all outline-none group shrink-0">
                <p className="text-[11px] font-black text-purple-700 uppercase tracking-widest">이곳을 클릭 후 엑셀 데이터를 붙여넣으세요 (Ctrl+V)</p>
                <p className="text-[9px] text-purple-400 font-bold mt-1">[ 형식: 유라품번 / 업체품번 / 품목 / 제조사 / MOQ / PPQ ]</p>
              </div>
              <div className="flex-1 overflow-auto custom-scrollbar">
                <table className="w-full text-left text-xs whitespace-nowrap">
                  <thead className="bg-slate-900 text-white sticky top-0 font-bold z-10">
                    <tr>
                      <th className="p-4">유라 품번</th>
                      <th className="p-4 text-emerald-400">업체 품번</th>
                      <th className="p-4">품목</th>
                      <th className="p-4">제조사</th>
                      <th className="p-4 text-center">MOQ</th>
                      <th className="p-4 text-center">PPQ</th>
                      <th className="p-4 text-right">업데이트 일자</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {infoRecords.filter(item => item.pn.includes(cleanPN(infoRecordSearch))).slice(0, 50).map((item) => (
                      <tr key={item.pn} className="hover:bg-slate-50 transition-colors">
                        <td className="p-4 font-black">{item.rawPn}</td>
                        <td className={`p-4 font-bold ${item.supplierPn === '임시' ? 'text-slate-300' : 'text-emerald-600'}`}>{item.supplierPn}</td>
                        <td className={`p-4 ${item.itemName === '임시' ? 'text-slate-300' : 'font-bold text-slate-600'}`}>{item.itemName}</td>
                        <td className={`p-4 ${item.manufacturer === '임시' ? 'text-slate-300' : 'font-black text-purple-700'}`}>{item.manufacturer}</td>
                        <td className={`p-4 text-center ${item.moq === '임시' ? 'text-slate-300' : 'font-bold'}`}>{item.moq}</td>
                        <td className={`p-4 text-center ${item.ppq === '임시' ? 'text-slate-300' : 'font-bold'}`}>{item.ppq}</td>
                        <td className="p-4 text-right text-slate-400 font-mono text-[10px]">{item.lastUpdated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {infoRecords.length > 50 && (
                  <div className="p-4 text-center text-slate-400 font-bold text-[10px] bg-slate-50 italic">... 데이터가 많아 상위 50건만 표시 중입니다. 검색 기능을 이용하세요 ...</div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'input' && (
          <div className="flex flex-col h-full gap-4 min-h-0">
            <div className="flex justify-end shrink-0">
              <div className="relative flex items-center mr-2 self-end">
                  <Search size={14} className="absolute left-3 text-slate-400" />
                  <input 
                    type="text" 
                    placeholder="전체 입력 데이터 품번 검색..." 
                    value={inputSearchInput}
                    onChange={(e) => setInputSearchInput(e.target.value)}
                    className="pl-9 pr-4 py-2 rounded-xl text-xs font-bold outline-none border border-slate-300 focus:border-indigo-500 shadow-sm w-64 bg-white"
                  />
                  {inputSearchInput && <X size={14} className="absolute right-3 text-slate-400 cursor-pointer hover:text-slate-600" onClick={() => {setInputSearchInput(''); setInputSearchQuery('');}} />}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-6 flex-1 min-h-0">
              <div tabIndex={0} onPaste={e => parseData(e, 'recv')} className="col-span-1 paste-area bg-white rounded-3xl border-2 border-dashed border-blue-200 flex flex-col transition-all overflow-hidden relative shadow-sm h-[400px] focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-500/20 outline-none">
                  <div className="px-4 py-3 bg-blue-50 border-b border-blue-100 flex items-center justify-between sticky top-0 z-30 shrink-0">
                      <div className="flex items-center gap-2">
                          <span className="font-black text-blue-800 text-[11px] flex items-center gap-1.5"><Box size={13}/> 1. 입고 내역</span>
                          <button onClick={(e) => { e.stopPropagation(); setAppendModal({isOpen:true, type:'recv', title:'입고 내역 누적 추가 등록'}); }} className="px-2 py-0.5 text-[9px] font-black bg-blue-600 text-white rounded shadow hover:bg-blue-700 active:scale-95 transition-all cursor-pointer z-40">+ 추가등록</button>
                      </div>
                      <span className="text-[9px] font-bold px-2 py-1 rounded bg-white shadow-sm text-slate-600">Rows: {filteredRecvData.length} <span className="text-blue-500 ml-1">| 총 합계 {inputSums.recv.toLocaleString()}개</span></span>
                  </div>
                  <div className="flex-1 overflow-auto custom-scrollbar bg-white min-h-0">
                      {memoizedRecvTable}
                  </div>
              </div>
              
              <div tabIndex={0} onPaste={e => parseData(e, 'bl')} className="col-span-3 paste-area bg-white rounded-3xl border-2 border-dashed border-slate-300 flex flex-col transition-all overflow-hidden relative shadow-sm h-[400px] focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-500/20 outline-none">
                  <div className="px-4 py-3 bg-indigo-50 border-b border-indigo-100 flex items-center justify-between sticky top-0 z-30 shrink-0">
                      <span className="font-black text-indigo-800 text-[11px] flex items-center gap-1.5"><Clipboard size={13}/> 2. 발주 대장 (11컬럼 대응)</span>
                      <span className="text-[9px] font-bold px-2 py-1 rounded bg-white shadow-sm text-slate-600 uppercase tracking-tighter">Rows: {filteredBacklogData.length} <span className="text-indigo-500 ml-1">| 총 미결량 {inputSums.backlog.toLocaleString()}개</span></span>
                  </div>
                  <div className="flex-1 overflow-auto custom-scrollbar bg-white min-h-0">
                      {memoizedBacklogTable}
                  </div>
              </div>
              
              <div tabIndex={0} onPaste={e => parseData(e, 'dist')} className="col-span-3 paste-area bg-white rounded-3xl border-2 border-dashed border-emerald-200 flex flex-col transition-all overflow-hidden relative shadow-sm h-[380px] focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-500/20 outline-none">
                  <div className="px-4 py-3 bg-emerald-50 border-b border-emerald-100 flex items-center justify-between sticky top-0 z-30 shrink-0">
                      <div className="flex items-center gap-2">
                          <span className="font-black text-emerald-800 text-[11px] flex items-center gap-1.5"><FileSpreadsheet size={13}/> 3. 분배 지시</span>
                          <button onClick={(e) => { e.stopPropagation(); setAppendModal({isOpen:true, type:'dist', title:'분배 지시 누적 추가 등록'}); }} className="px-2 py-0.5 text-[9px] font-black bg-emerald-600 text-white rounded shadow hover:bg-emerald-700 active:scale-95 transition-all cursor-pointer z-40">+ 추가등록</button>
                      </div>
                      <span className="text-[9px] font-bold px-2 py-1 rounded bg-white shadow-sm text-slate-600 uppercase tracking-tighter">Rows: {filteredDistData.length} <span className="text-emerald-500 ml-1">| 총 지시량 {inputSums.dist.toLocaleString()}개</span></span>
                  </div>
                  <div className="bg-rose-50 text-rose-600 text-[10px] font-bold px-4 py-1.5 border-b border-rose-100 flex items-center gap-1 shrink-0"><AlertTriangle size={12}/> ** PO분배지시된 수량이 일반 분배지시에 중복으로 반영되지 않도록 주의 바랍니다. (납기대로 = 자동배정 처리됨)</div>
                  <div className="flex-1 overflow-auto custom-scrollbar bg-white min-h-0">
                      {memoizedDistTable}
                  </div>
              </div>

              <div tabIndex={0} onPaste={e => parseData(e, 'poDist')} className="col-span-1 paste-area bg-white rounded-3xl border-2 border-dashed border-purple-200 flex flex-col transition-all overflow-hidden relative shadow-sm h-[380px] focus-within:border-purple-500 focus-within:ring-4 focus-within:ring-purple-500/20 outline-none">
                  <div className="px-4 py-3 bg-purple-50 border-b border-purple-100 flex items-center justify-between sticky top-0 z-30 shrink-0">
                      <span className="font-black text-purple-800 text-[11px] flex items-center gap-1.5"><Clipboard size={13}/> 4. PO 분배 지시 (0순위)</span>
                      <span className="text-[9px] font-bold px-2 py-1 rounded bg-white shadow-sm text-slate-600 uppercase tracking-tighter">Rows: {filteredPoDistData.length} <span className="text-purple-500 ml-1">| 총 지시량 {inputSums.poDist.toLocaleString()}개</span></span>
                  </div>
                  <div className="bg-rose-50 text-rose-600 text-[10px] font-bold px-4 py-1.5 border-b border-rose-100 flex items-center gap-1 shrink-0"><AlertTriangle size={12}/> ** 중복 배정 주의</div>
                  <div className="flex-1 overflow-auto custom-scrollbar bg-white min-h-0">
                      {memoizedPoDistTable}
                  </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'db' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full flex-1 min-h-0">
            <div className="col-span-2 bg-white rounded-3xl border border-slate-200 shadow-sm flex flex-col overflow-hidden min-h-0">
                <div className="px-6 py-4 bg-sky-50 border-b border-sky-100 flex items-center justify-between shrink-0">
                  <h3 className="font-black text-sky-800 flex items-center gap-2 uppercase tracking-tighter"><Link2 size={18}/> Factory Mapping DB</h3>
                  <span className="text-xs font-bold text-sky-600 bg-white px-3 py-1 rounded-full shadow-sm">Total: {factoryDB.length}</span>
                </div>
                <div className="p-4 bg-slate-50 border-b border-slate-200 shrink-0">
                  <div tabIndex={0} onPaste={e => parseData(e, 'fdb')} className="paste-area relative w-full py-4 bg-white border-2 border-dashed border-sky-200 rounded-xl text-center cursor-pointer transition-all outline-none shadow-inner flex flex-col items-center justify-center min-h-[80px] focus-within:border-sky-500 focus-within:ring-4 focus-within:ring-sky-500/20">
                    <p className="text-xs font-black text-slate-600 mb-1 uppercase italic tracking-widest text-[11px]">Paste Factory Matching Data (Ctrl+V)</p>
                    <p className="text-[9px] font-bold text-slate-400 mt-1">이 박스를 클릭하여 선택(파란 테두리) 후 붙여넣기 하세요.</p>
                  </div>
                </div>
                <div className="flex-1 overflow-auto custom-scrollbar select-text bg-white min-h-0">
                  {memoizedFactoryDBTable}
                </div>
            </div>
            
            <div className="col-span-1 flex flex-col gap-6 h-full min-h-0">
                <div className="bg-white rounded-3xl border border-slate-200 flex flex-col overflow-hidden shadow-sm shrink-0">
                    <div className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                      <span className="font-black text-white text-[11px] flex items-center gap-1.5 uppercase tracking-tighter"><Settings2 size={13} className="text-indigo-400"/> Priority Config</span>
                      <div className="flex gap-1">
                        <input type="text" value={newFactoryName} onChange={(e) => setNewFactoryName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && addFactory()} placeholder="Add" className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-700 outline-none w-14 bg-slate-800 text-white" />
                        <button onClick={addFactory} className="bg-indigo-600 text-white p-1 rounded-md active:scale-90 transition-all"><Plus size={12}/></button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 flex flex-col h-[150px]">
                       <p className="text-[9px] font-bold text-indigo-500 bg-indigo-50 px-2 py-1 rounded mb-3">* 공장 우선순위를 지정하세요.</p>
                       <div className="flex flex-wrap content-start gap-1 w-full overflow-auto custom-scrollbar">
                         {factories.filter(Boolean).map((name, index) => (
                           <div key={name||index} draggable onDragStart={(e) => handleDragStart(e, index)} onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, index)} className={`group px-2 py-1.5 rounded-lg text-[9px] font-black shadow-sm flex items-center justify-between transition-all border shrink-0 ${name === '자동배정' || name === '판매' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-white border-slate-200 text-slate-700 hover:border-indigo-400 cursor-move'}`}>
                             <div className="flex items-center gap-1">
                               {name !== '자동배정' && name !== '판매' && <GripHorizontal size={10} className="text-slate-300 group-hover:text-indigo-400" />}
                               <span>{index + 1}. {name}</span>
                             </div>
                             {name !== '자동배정' && name !== '판매' && <X size={10} className="cursor-pointer text-slate-300 hover:text-red-500 ml-1.5" onClick={() => removeFactory(name)} />}
                           </div>
                         ))}
                       </div>
                    </div>
                </div>

                <div className="bg-white rounded-3xl border border-slate-200 flex flex-col overflow-hidden shadow-sm shrink-0">
                    <div className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                      <span className="font-black text-white text-[11px] flex items-center gap-1.5 uppercase tracking-tighter"><Users size={13} className="text-indigo-400"/> Supplier DB</span>
                      <div className="flex gap-1">
                        <input type="text" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && addSupplier()} placeholder="Add Supplier" className="px-2 py-1 rounded-md text-[10px] font-bold border border-slate-700 outline-none w-20 bg-slate-800 text-white" />
                        <button onClick={addSupplier} className="bg-indigo-600 text-white p-1 rounded-md active:scale-90 transition-all"><Plus size={12}/></button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 flex flex-col h-[150px]">
                       <p className="text-[9px] font-bold text-indigo-500 bg-indigo-50 px-2 py-1 rounded mb-3">* 부품사별 자동배분 출고제한(D+) 설정 및 <strong>[당월납기/제외]</strong> 관리가 가능합니다.</p>
                       <div className="flex flex-wrap content-start gap-1.5 w-full overflow-auto custom-scrollbar">
                         {suppliers.map((supp, index) => (
                           <div key={supp.id||index} draggable onDragStart={(e) => handleSupplierDragStart(e, index)} onDragOver={handleDragOver} onDrop={(e) => handleSupplierDrop(e, index)} className="group px-2 py-1.5 rounded-lg text-[9px] font-black shadow-sm flex items-center justify-between transition-all border shrink-0 bg-white border-slate-200 text-slate-700 hover:border-indigo-400 cursor-move">
                             <div className="flex items-center gap-1">
                               <GripHorizontal size={10} className="text-slate-300 group-hover:text-indigo-400" />
                               <span>{supp.name}</span>
                               <div className="ml-0.5 flex items-center bg-slate-50 border border-slate-200 rounded px-1" title="D+일 설정 및 당월 납기 제한">
                                 <span className="text-[8px] text-slate-400">D+</span>
                                 <input type="number" value={supp.dPlus !== undefined ? supp.dPlus : ''} onChange={e => updateSupplierDPlus(supp.id, e.target.value)} className="w-6 text-[9px] font-bold text-center outline-none text-indigo-600 bg-transparent" placeholder="∞" />
                                 <label className="flex items-center gap-0.5 ml-0.5 pl-1 border-l border-slate-200 cursor-pointer" title="당월 납기 물량만 자동 배정">
                                   <input type="checkbox" checked={!!supp.isCurrentMonthOnly} onChange={e => toggleSupplierCurrentMonth(supp.id, e.target.checked)} className="w-2.5 h-2.5 accent-indigo-600 cursor-pointer" />
                                   <span className="text-[8px] text-slate-500 font-black">당월</span>
                                 </label>
                                 <label className="flex items-center gap-0.5 ml-1 pl-1 border-l border-slate-200 cursor-pointer" title="자동 배분 대상에서 제외">
                                   <input type="checkbox" checked={!!supp.isExcluded} onChange={e => toggleSupplierExclude(supp.id, e.target.checked)} className="w-2.5 h-2.5 accent-rose-500 cursor-pointer" />
                                   <span className="text-[8px] text-slate-500 font-black">제외</span>
                                 </label>
                               </div>
                             </div>
                             <X size={10} className="cursor-pointer text-slate-300 hover:text-red-500 ml-1.5" onClick={() => removeSupplier(supp.id)} />
                           </div>
                         ))}
                       </div>
                    </div>
                </div>

                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm flex flex-col overflow-hidden flex-1 min-h-0">
                  <div className="px-5 py-3 bg-indigo-50 border-b border-indigo-100 flex items-center justify-between sticky top-0"><h3 className="font-black text-indigo-800 flex items-center gap-2 text-xs uppercase tracking-tighter"><History size={14}/> DB History</h3></div>
                  <div className="flex-1 overflow-auto custom-scrollbar p-5 bg-white min-h-0">
                    {historyList.map((h, i) => (
                      <div key={h.id||i} className="flex justify-between items-center p-3 mb-2 bg-slate-50 border border-slate-200 rounded-xl hover:border-indigo-300 hover:shadow-md transition-all group">
                        <div className="flex-1 min-w-0 pr-2">
                          <p className="font-black text-slate-800 text-[11px] truncate uppercase">{h.name}</p>
                          <p className="text-[9px] text-slate-500 font-bold mt-0.5">{h.date}</p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button onClick={() => loadState(h)} className="p-1.5 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 transition-colors"><FolderDown size={14}/></button>
                          <button onClick={() => deleteState(h.id)} className="p-1.5 bg-white text-rose-400 border border-rose-100 rounded-lg hover:bg-rose-50 hover:text-rose-600 transition-colors shadow-sm"><Trash2 size={14}/></button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
            </div>
          </div>
        )}

        {activeTab === 'results' && results.length > 0 && (
          <div className="space-y-6 animate-fade-in flex-1 flex flex-col min-h-0">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-6 shrink-0">
              <div className="bg-white p-6 rounded-[2rem] border-l-[10px] border-blue-500 shadow-sm transition-transform hover:-translate-y-1"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">총 입고량</span><p className="text-3xl font-black mt-2 tracking-tighter text-blue-700">{summaryCounts.totalReceived.toLocaleString()}</p></div>
              <div className="bg-white p-6 rounded-[2rem] border-l-[10px] border-indigo-500 shadow-sm transition-transform hover:-translate-y-1"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">지시 배정 합계</span><p className="text-3xl font-black mt-2 tracking-tighter text-indigo-700">{summaryCounts.totalDist.toLocaleString()}</p></div>
              <div className="bg-white p-6 rounded-[2rem] border-l-[10px] border-teal-500 shadow-sm transition-transform hover:-translate-y-1"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">자동 배정 합계</span><p className="text-3xl font-black mt-2 tracking-tighter text-teal-700">{summaryCounts.totalAuto.toLocaleString()}</p></div>
              <div className="bg-white p-6 rounded-[2rem] border-l-[10px] border-slate-400 shadow-sm transition-transform hover:-translate-y-1"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">창고재고 (미배정)</span><p className="text-3xl font-black mt-2 tracking-tighter text-slate-600">{summaryCounts.totalWarehouse.toLocaleString()}</p></div>
              <div className="bg-white p-6 rounded-[2rem] border-l-[10px] border-emerald-500 shadow-sm transition-transform hover:-translate-y-1"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">최종 배정 총량</span><p className="text-3xl font-black mt-2 tracking-tighter text-emerald-600">{summaryCounts.totalAllocated.toLocaleString()}</p></div>
            </div>
            
            <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 overflow-hidden flex flex-col flex-1 min-h-0">
               <div className="px-8 py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
                 <div className="flex gap-2 p-1 bg-slate-200/50 rounded-xl">
                    <button onClick={() => withLoading(() => setResultSubTab('summary'))} className={`px-5 py-2 rounded-lg font-black text-xs transition-all ${resultSubTab === 'summary' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>품목별 분석 요약</button>
                    <button onClick={() => withLoading(() => setResultSubTab('detail'))} className={`px-5 py-2 rounded-lg font-black text-xs transition-all ${resultSubTab === 'detail' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>전체 배정 내역</button>
                    <button onClick={() => withLoading(() => setResultSubTab('updatedBacklog'))} className={`px-5 py-2 rounded-lg font-black text-xs transition-all ${resultSubTab === 'updatedBacklog' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>잔여 발주대장 갱신 리포트</button>
                 </div>
                 
                 <div className="flex items-center gap-3">
                   {/* ⭐️ 신규: 3가지 직관적 에러 필터링 버튼 세트 */}
                   <div className="flex gap-1.5 bg-white p-1.5 rounded-xl border border-slate-200 shadow-sm">
                       <span className="flex items-center text-[10px] font-black text-slate-400 mx-2"><AlertTriangle size={12} className="mr-1"/> 에러 필터:</span>
                       <button onClick={() => setErrorFilters(p => ({...p, shortage: !p.shortage}))} className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${errorFilters.shortage ? 'bg-rose-100 text-rose-700 border border-rose-300 shadow-inner' : 'text-slate-500 bg-slate-50 hover:bg-slate-100'}`}>PO 부족</button>
                       <button onClick={() => setErrorFilters(p => ({...p, distOverRecv: !p.distOverRecv}))} className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${errorFilters.distOverRecv ? 'bg-orange-100 text-orange-700 border border-orange-300 shadow-inner' : 'text-slate-500 bg-slate-50 hover:bg-slate-100'}`}>지시 초과</button>
                       <button onClick={() => setErrorFilters(p => ({...p, allocDiff: !p.allocDiff}))} className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${errorFilters.allocDiff ? 'bg-amber-100 text-amber-700 border border-amber-300 shadow-inner' : 'text-slate-500 bg-slate-50 hover:bg-slate-100'}`}>배정 차이</button>
                   </div>
                   
                   <button 
                     onClick={() => setShowAppendedOnly(!showAppendedOnly)}
                     className={`px-4 py-2.5 rounded-xl text-xs font-black shadow-sm flex items-center gap-1.5 transition-all border ${showAppendedOnly ? 'bg-amber-100 text-amber-700 border-amber-300' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'}`}
                   >
                     {showAppendedOnly ? '✅ 추가 내역만 보는 중' : '추가 내역만 보기'}
                   </button>
                   <div className="relative flex items-center mr-4">
                     <Search size={14} className="absolute left-3 text-slate-400" />
                     <input 
                       type="text" 
                       placeholder="품번 검색 후 Enter..." 
                       value={searchInput}
                       onChange={(e) => setSearchInput(e.target.value)}
                       onKeyDown={(e) => e.key === 'Enter' && handleSearchEnter()}
                       className="pl-9 pr-4 py-2.5 rounded-xl text-xs font-bold outline-none border border-slate-300 focus:border-indigo-500 shadow-sm w-64 bg-white"
                     />
                     {searchInput && <X size={14} className="absolute right-3 text-slate-400 cursor-pointer hover:text-slate-600" onClick={() => {setSearchInput(''); setSearchQuery('');}} />}
                   </div>
                   {resultSubTab === 'detail' && (<button onClick={exportDetailToExcel} className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-black shadow-md flex items-center gap-2 hover:bg-emerald-700 active:scale-95 uppercase tracking-tighter"><DownloadCloud size={14}/> 결과 엑셀복사</button>)}
                   {resultSubTab === 'updatedBacklog' && (<button onClick={exportUpdatedBacklogToExcel} className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-xs font-black shadow-md flex items-center gap-2 hover:bg-indigo-700 active:scale-95 uppercase tracking-tighter"><DownloadCloud size={14}/> 잔여 발주대장 엑셀복사</button>)}
                 </div>
               </div>
               
               <div className="flex-1 overflow-auto select-text custom-scrollbar min-h-0 bg-white">
                  {resultSubTab === 'summary' && memoizedSummaryTable}
                  {resultSubTab === 'detail' && memoizedDetailTable}
                  {resultSubTab === 'updatedBacklog' && memoizedUpdatedBacklogTable}
               </div>
            </div>
          </div>
        )}
      </main>

      {renderMissingDBModal()}
      {renderDetailModal()}
      {renderHistoryModal()}
      {/* 낡고 복잡한 오류 팝업 모달창 렌더링 삭제 완료 */}

      <footer className="text-center p-8 bg-slate-900/5 mt-auto shrink-0 border-t border-slate-200/50">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em] italic shadow-white">Produced by SlicerPro Logic Engine Optimized v10.5 Stable</p>
      </footer>
    </div>
  );
};

export default App;