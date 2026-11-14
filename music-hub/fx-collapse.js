/* Independent FX/filter visibility preference. Never sends controller commands. */
(()=>{'use strict';
 function init(){
  const fx=document.querySelector('#performance-panel .pc-effects');
  if(!fx||fx.querySelector('.fx-collapse-bar'))return;
  fx.id='music-hub-effects-panel';
  const controls=[...fx.children];
  controls.forEach((el,i)=>{el.id=el.id||'music-hub-fx-section-'+i;});
  const button=document.createElement('button');button.type='button';button.className='fx-collapse-bar';
  button.setAttribute('aria-controls',controls.map(e=>e.id).join(' '));
  button.innerHTML='<span class="fx-collapse-arrow" aria-hidden="true"></span><span>FX / FILTER</span><span class="fx-collapse-note">READ-ONLY PREVIEW</span>';
  fx.prepend(button);
  let collapsed=false;try{collapsed=localStorage.getItem('music-hub-fx-collapsed-v1')==='true';}catch{}
  function render(){fx.classList.toggle('fx-collapsed',collapsed);button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',(collapsed?'Expand':'Collapse')+' FX and filter panel');button.querySelector('.fx-collapse-arrow').textContent=collapsed?'›':'⌄';}
  button.addEventListener('click',()=>{collapsed=!collapsed;render();try{localStorage.setItem('music-hub-fx-collapsed-v1',String(collapsed));}catch{}});render();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
