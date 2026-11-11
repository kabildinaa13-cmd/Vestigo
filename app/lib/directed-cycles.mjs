// Iterative Kosaraju: an edge is cyclic only if its endpoints share a directed SCC.
// Layout levels and undirected distances must never be used as financial evidence.
export function markDirectedCycles(edges){
  const forward=new Map(),reverse=new Map();
  const node=id=>{if(!forward.has(id)){forward.set(id,[]);reverse.set(id,[]);}};
  for(const e of edges){node(e.from);node(e.to);forward.get(e.from).push(e.to);reverse.get(e.to).push(e.from);}
  const visited=new Set(),order=[];
  for(const start of forward.keys()){
    if(visited.has(start))continue;
    visited.add(start);const stack=[{id:start,next:0}];
    while(stack.length){const top=stack[stack.length-1],neighbors=forward.get(top.id);
      if(top.next<neighbors.length){const next=neighbors[top.next++];if(!visited.has(next)){visited.add(next);stack.push({id:next,next:0});}}
      else{order.push(top.id);stack.pop();}
    }
  }
  const component=new Map(),sizes=[];
  for(let n=order.length-1;n>=0;n--){const start=order[n];if(component.has(start))continue;
    const id=sizes.length,stack=[start];let count=0;component.set(start,id);
    while(stack.length){const current=stack.pop();count++;for(const next of reverse.get(current))if(!component.has(next)){component.set(next,id);stack.push(next);}}
    sizes.push(count);
  }
  return edges.map(e=>({...e,cycle:component.get(e.from)===component.get(e.to)&&(e.from===e.to||sizes[component.get(e.from)]>1)}));
}
