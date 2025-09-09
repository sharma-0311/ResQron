from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Tuple
import heapq, math

app = FastAPI()

class PlanRequest(BaseModel):
    start: List[float]
    goal: List[float]   
    blocked: List[List[float]] = []  # list of [lat,lng] blocked cells
    deny: List[List[List[float]]] = []  # polygons

class PlanResponse(BaseModel):
    path: List[List[float]]


def astar(start: Tuple[float,float], goal: Tuple[float,float], blocked: set):
    def h(a,b):
        return abs(a[0]-b[0]) + abs(a[1]-b[1])
    openq = []
    heapq.heappush(openq, (0, start))
    came = {start: None}
    g = {start: 0}
    while openq:
        _, cur = heapq.heappop(openq)
        if cur == goal:
            path = []
            while cur is not None:
                path.append(list(cur))
                cur = came[cur]
            return list(reversed(path))
        for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]:
            nb = (round(cur[0]+dx*1e-3,6), round(cur[1]+dy*1e-3,6))
            if nb in blocked:
                continue
            ng = g[cur] + 1
            if nb not in g or ng < g[nb]:
                g[nb] = ng
                came[nb] = cur
                f = ng + h(nb, goal)
                heapq.heappush(openq, (f, nb))
    return []

@app.post('/plan', response_model=PlanResponse)
async def plan(req: PlanRequest):
    start = (round(req.start[0],6), round(req.start[1],6))
    goal = (round(req.goal[0],6), round(req.goal[1],6))
    blocked = set((round(b[0],6), round(b[1],6)) for b in req.blocked)
    path = astar(start, goal, blocked)
    if not path:
        raise HTTPException(status_code=400, detail='no path')
    return PlanResponse(path=path)

class AvoidRequest(BaseModel):
    position: List[float]
    obstacle: List[float]  # [lat,lng]
    heading: float = 0.0

class AvoidResponse(BaseModel):
    new_heading: float
    command: str

@app.post('/avoid', response_model=AvoidResponse)
async def avoid(req: AvoidRequest):
    # Simple reactive avoid: sidestep 10 degrees if obstacle is within ~5m grid
    # Placeholder: replace with potential fields or VFH
    cmd = 'hold'
    new_hdg = req.heading
    if abs(req.position[0]-req.obstacle[0]) < 5e-4 and abs(req.position[1]-req.obstacle[1]) < 5e-4:
        cmd = 'sidestep'
        new_hdg = (req.heading + 10.0) % 360.0
    return AvoidResponse(new_heading=new_hdg, command=cmd)
